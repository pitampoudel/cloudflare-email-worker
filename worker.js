/**
 * Cloudflare Email Worker → Slack + Email Forwarding
 * Upload raw email (.eml) to Slack using External Upload API,
 * and optionally forward to a specified email address.
 *
 * Env:
 *  - SLACK_BOT_TOKEN         (required)
 *  - ROUTES_JSON             (optional) {"rcpt@domain.com": {type:"channel", id:"C...", forwardTo:"fwd@example.com"} | {type:"dm", user:"U...", forwardTo:"..."} }
 *  - FALLBACK_CHANNEL_ID     (required if ROUTES_JSON doesn't match) e.g. "C0123ABCDEF"
 *  - SMTP_FROM               (optional) Sender address for SMTP fallback
 *  - SMTP_HOST               (optional) SMTP relay host (HTTP endpoint for MailChannels or similar)
 *  - SMTP_PORT               (optional) SMTP relay port
 *  - SMTP_USERNAME            (optional) SMTP relay username
 *  - SMTP_PASSWORD            (optional) SMTP relay password
 */

export default {
    async email(message, env, ctx) {
        try {
            const token = env.SLACK_BOT_TOKEN;
            if (!token) return; // never bounce

            const routes = safeJson(env.ROUTES_JSON, {});
            const rcpt = getPrimaryRecipient(message);

            const fallbackChannelId = env.FALLBACK_CHANNEL_ID;
            const route = normalizeRoute(routes?.[rcpt]) ?? buildFallbackRoute(fallbackChannelId);
            if (!route) {
                console.error("No valid Slack route or fallback channel configured; skipping", { rcpt });
                return;
            }

            const rawBytes = await getRawEmailBytes(message);
            if (!rawBytes?.byteLength) {
                console.warn("Empty raw email bytes; skipping upload", {
                    rcpt,
                    hasRaw: !!message?.raw,
                    rawType: typeof message?.raw,
                });
                return;
            }

            ctx.waitUntil(forwardRawEmlToSlackBytes(token, route, rawBytes));

            if (route.forwardTo) {
                ctx.waitUntil(forwardToEmail(message, route.forwardTo, rawBytes, env));
            }
        } catch (e) {
            // never bounce
            console.error("Email handler crashed", e);
        }
    },
};

/* ------------------------- Main forwarding (bytes already buffered) ------------------------- */

async function forwardRawEmlToSlackBytes(token, route, rawBytes) {
    try {
        const channelId = await resolveSlackTargetId(token, route);
        if (!channelId) {
            console.error("Unable to resolve Slack target", route);
            return;
        }

        if (rawBytes.byteLength < 20) {
            console.warn("Suspiciously small .eml payload", { size: rawBytes.byteLength });
        }

        const filename = `email-${Date.now()}.eml`;
        const ok = await uploadBytesToSlack(token, channelId, filename, rawBytes);
        if (!ok) console.error("Upload failed", { channelId, filename });
    } catch (e) {
        console.error("forwardRawEmlToSlackBytes crashed", e);
    }
}

/* ----------------------------- Email forwarding ----------------------------- */

async function forwardToEmail(message, forwardTo, rawBytes, env) {
    try {
        // Primary: use Cloudflare's native message.forward()
        await message.forward(forwardTo);
        console.log("Email forwarded successfully via message.forward()", { forwardTo });
        return;
    } catch (e) {
        console.warn("message.forward() failed, attempting SMTP fallback", { forwardTo, error: e?.message });
    }

    // Fallback: send via SMTP relay (MailChannels or configured SMTP HTTP endpoint)
    try {
        await sendViaSmtp(forwardTo, rawBytes, env);
    } catch (e) {
        console.error("SMTP fallback also failed", { forwardTo, error: e?.message });
    }
}

async function sendViaSmtp(forwardTo, rawBytes, env) {
    const smtpFrom = env.SMTP_FROM;
    const smtpHost = env.SMTP_HOST;
    const smtpUsername = env.SMTP_USERNAME;
    const smtpPassword = env.SMTP_PASSWORD;
    const smtpPort = env.SMTP_PORT || "587";

    if (!smtpFrom || !smtpHost) {
        console.error("SMTP fallback not configured (SMTP_FROM and SMTP_HOST required)");
        return;
    }

    const PostalMime = (await import("postal-mime")).default;
    const parser = new PostalMime();
    const emailText = new TextDecoder().decode(rawBytes);
    const parsed = await parser.parse(emailText);

    const payload = {
        from: { email: smtpFrom },
        to: [{ email: forwardTo }],
        subject: parsed.subject || "(no subject)",
        text: parsed.text || "",
        html: parsed.html || "",
    };

    if (parsed.attachments?.length) {
        payload.attachments = parsed.attachments.map((att) => ({
            filename: att.filename || "attachment",
            content: uint8ArrayToBase64(new Uint8Array(att.content)),
            type: att.mimeType || "application/octet-stream",
        }));
    }

    // Try MailChannels API first (free for Cloudflare Workers, host = "api.mailchannels.net")
    if (smtpHost === "api.mailchannels.net") {
        const mcPayload = {
            personalizations: [{ to: [{ email: forwardTo }] }],
            from: { email: smtpFrom },
            subject: payload.subject,
            content: [
                ...(payload.text ? [{ type: "text/plain", value: payload.text }] : []),
                ...(payload.html ? [{ type: "text/html", value: payload.html }] : []),
            ],
        };
        if (payload.attachments?.length) {
            mcPayload.attachments = payload.attachments;
        }
        const res = await fetch("https://api.mailchannels.net/tx/v1/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(mcPayload),
        });
        if (res.ok) {
            console.log("Email sent via MailChannels", { forwardTo });
            return;
        }
        console.error("MailChannels send failed", { status: res.status, body: await safeText(res) });
        return;
    }

    // Generic SMTP HTTP relay (e.g., SendGrid, Mailgun, or custom SMTP-to-HTTP bridge)
    // Expects a POST https://<SMTP_HOST>:<SMTP_PORT>/send endpoint accepting JSON payload
    const authHeader = smtpUsername && smtpPassword
        ? { Authorization: "Basic " + btoa(`${smtpUsername}:${smtpPassword}`) }
        : {};

    const smtpUrl = `https://${smtpHost}:${smtpPort}/send`;
    const res = await fetch(smtpUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...authHeader,
        },
        body: JSON.stringify(payload),
    });

    if (res.ok) {
        console.log("Email sent via SMTP relay", { forwardTo, smtpHost });
    } else {
        console.error("SMTP relay send failed", { status: res.status, body: await safeText(res) });
    }
}

function uint8ArrayToBase64(bytes) {
    const chunkSize = 8192;
    const parts = [];
    for (let i = 0; i < bytes.byteLength; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        parts.push(String.fromCharCode(...chunk));
    }
    return btoa(parts.join(""));
}

/* -------------------- Slack target resolution (channel / dm) -------------------- */

async function resolveSlackTargetId(token, route) {
    if (route?.type === "dm") {
        if (!route.user) return null;
        const res = await slackApiForm(token, "conversations.open", { users: route.user });
        return res.ok ? res.channel?.id ?? null : null;
    }

    if (route?.type === "channel") {
        // require channel ID for simplicity
        if (!route.id || !/^[CG][A-Z0-9]+$/.test(route.id)) return null;
        return route.id;
    }

    return null;
}

/* ------------------------------ Slack upload (external) ------------------------------ */

async function uploadBytesToSlack(token, channelId, filename, bytes) {
    // 1) files.getUploadURLExternal
    const getUrlRes = await slackApiForm(token, "files.getUploadURLExternal", {
        filename,
        length: String(bytes.byteLength),
    });

    if (!getUrlRes.ok) {
        console.error("files.getUploadURLExternal failed:", getUrlRes);
        return false;
    }

    // 2) POST bytes to upload_url
    // Slack expects the raw bytes to be POSTed to the returned upload_url.
    const uploadRes = await fetch(getUrlRes.upload_url, {
        method: "POST",
        headers: {
            "Content-Type": "application/octet-stream",
            // Optional but helps some runtimes:
            "Content-Length": String(bytes.byteLength),
        },
        body: bytes,
    });

    if (!uploadRes.ok) {
        console.error("Upload failed:", uploadRes.status, await safeText(uploadRes));
        return false;
    }

    // 3) files.completeUploadExternal (shares file to channel)
    const completeRes = await slackApiForm(token, "files.completeUploadExternal", {
        files: JSON.stringify([{ id: getUrlRes.file_id, title: filename }]),
        channel_id: channelId,
    });

    if (!completeRes.ok) {
        if (completeRes.error === "channel_not_found") {
            console.error("Slack channel not found or bot missing from channel", { channelId, completeRes });
        } else {
            console.error("files.completeUploadExternal failed:", completeRes);
        }
        return false;
    }

    return true;
}

async function slackApiForm(token, method, fields) {
    const url = `https://slack.com/api/${method}`;
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);

    const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
    });

    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        return { ok: false, error: "non_json_response", httpStatus: res.status, body: text.slice(0, 300) };
    }
}

async function safeText(res) {
    try {
        return (await res.text()).slice(0, 500);
    } catch {
        return "";
    }
}

/* ---------------------------------- Recipient ---------------------------------- */

function getPrimaryRecipient(message) {
    const all = [];
    const to = message?.to;
    if (Array.isArray(to)) all.push(...to);
    else if (to) all.push(to);

    const toHeader = message?.headers?.get?.("to");
    if (toHeader) all.push(toHeader);

    const found = extractFirstEmail(all.join(", "));
    return (found || "unknown@unknown").toLowerCase();
}

function extractFirstEmail(s) {
    const m = String(s || "").match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
    return m ? m[1] : null;
}

function normalizeRoute(route) {
    if (!route || typeof route !== "object") return null;
    const type = String(route.type || "").toLowerCase();
    const forwardTo = route.forwardTo ? String(route.forwardTo) : undefined;

    if (type === "dm" && route.user) return { type: "dm", user: String(route.user), forwardTo };
    if (type === "channel" && route.id) return { type: "channel", id: String(route.id), forwardTo };

    return null;
}

function buildFallbackRoute(fallbackChannelId) {
    if (!fallbackChannelId) return null;
    return { type: "channel", id: String(fallbackChannelId) };
}

function safeJson(str, fallback) {
    try {
        return str ? JSON.parse(str) : fallback;
    } catch {
        return fallback;
    }
}

/* ------------------------------ Raw email bytes ------------------------------ */

async function getRawEmailBytes(message) {
    const raw = message?.raw;

    if (!raw) return new Uint8Array(0);

    if (raw instanceof Uint8Array) return raw;
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);

    // ReadableStream (one-time stream)
    if (raw && typeof raw.getReader === "function") {
        const reader = raw.getReader();
        const chunks = [];
        let total = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value?.byteLength) continue;
            chunks.push(value);
            total += value.byteLength;
        }

        const out = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
            out.set(c, offset);
            offset += c.byteLength;
        }
        return out;
    }

    if (typeof raw === "string") return new TextEncoder().encode(raw);

    // Fallback (Blob, Response-like, etc.)
    try {
        const ab = await new Response(raw).arrayBuffer();
        return new Uint8Array(ab);
    } catch (e) {
        console.error("Failed to read raw email bytes (fallback)", e);
        return new Uint8Array(0);
    }
}
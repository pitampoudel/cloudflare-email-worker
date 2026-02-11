/**
 * Cloudflare Email Worker → Slack
 * Simple: upload raw email (.eml) to Slack.
 *
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
                console.error("No valid Slack route or fallback channel configured; skipping");
                return;
            }

            ctx.waitUntil(forwardRawEmlToSlack(message, token, route));
        } catch (e) {
            // never bounce
            console.error("Email handler crashed", e);
        }
    },
};

async function forwardRawEmlToSlack(message, token, route) {
    try {
        const channelId = await resolveSlackTargetId(token, route);
        if (!channelId) {
            console.error("Unable to resolve Slack target", route);
            return;
        }

        const rawBytes = await getRawEmailBytes(message);
        if (!rawBytes?.byteLength) return;

        const filename = `email-${Date.now()}.eml`;

        await uploadBytesToSlack(token, channelId, filename, rawBytes);
    } catch (e) {
        console.error("forwardRawEmlToSlack crashed", e);
    }
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
    const uploadRes = await fetch(getUrlRes.upload_url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
    });
    if (!uploadRes.ok) {
        console.error("Upload failed:", uploadRes.status);
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
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        return { ok: false, error: "non_json_response", httpStatus: res.status, body: text.slice(0, 300) };
    }
    return json;
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

    if (type === "dm" && route.user) return { type: "dm", user: String(route.user) };
    if (type === "channel" && route.id) return { type: "channel", id: String(route.id) };

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

    if (raw instanceof Uint8Array) return raw;
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);

    // ReadableStream
    if (raw && typeof raw.getReader === "function") {
        const reader = raw.getReader();
        const chunks = [];
        let total = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
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

    // Fallback
    const ab = await new Response(raw).arrayBuffer();
    return new Uint8Array(ab);
}
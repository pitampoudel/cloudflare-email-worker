export default {
    async email(message, env, ctx) {
        const token = env.SLACK_BOT_TOKEN;
        if (!token) {
            console.error("Missing SLACK_BOT_TOKEN");
            message.setReject("missing configuration");
            return;
        }

        const routes = safeJson(env.ROUTES_JSON, {});
        const rcpt = getPrimaryRecipient(message);

        const route = routes[rcpt];
        if (!route) {
            message.setReject(`550 5.1.1 No such recipient: ${rcpt}`);
            return;
        }

        ctx.waitUntil(handleSlackForward(message, token, rcpt, route));
    },
};

async function handleSlackForward(message, token, rcpt, route) {
    try {
        let targetId;

        if (route.type === "dm") {
            targetId = await openDmChannel(token, route.user);
            if (!targetId) {
                console.error("Failed to open DM", { rcpt, user: route.user });
                return;
            }
        } else if (route.type === "channel") {
            targetId = route.id;

            // IMPORTANT: Channels are C... (public) or G... (private). D... is NOT a channel.
            if (!/^[CG][A-Z0-9]+$/.test(targetId)) {
                console.error("Invalid Slack channel id. Use C... or G... (not D... / not #name).", {
                    rcpt,
                    provided: targetId,
                });
                return;
            }
        } else {
            console.error("Invalid route type:", route.type);
            return;
        }

        const rawBytes = await getRawEmailBytes(message);
        const length = rawBytes.byteLength;

        const subject = message.headers.get("subject") || "no-subject";
        const from = message.from || "unknown";
        const filename = buildFilename(subject);

        const getUrlRes = await slackForm("files.getUploadURLExternal", token, {
            filename,
            length: String(length),
        });
        if (!getUrlRes.ok) {
            console.error("files.getUploadURLExternal failed:", getUrlRes);
            return;
        }

        const uploadRes = await fetch(getUrlRes.upload_url, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: rawBytes,
        });
        if (!uploadRes.ok) {
            const t = await uploadRes.text().catch(() => "");
            console.error("Upload failed:", uploadRes.status, t.slice(0, 500));
            return;
        }

        const comment =
            `📧 *New email*\n` +
            `*To:* ${rcpt}\n` +
            `*From:* ${from}\n` +
            `*Subject:* ${subject}`;

        const completeRes = await slackForm("files.completeUploadExternal", token, {
            files: JSON.stringify([{ id: getUrlRes.file_id, title: filename }]),
            channel_id: targetId,
            initial_comment: comment,
        });

        if (!completeRes.ok) {
            console.error("files.completeUploadExternal failed:", completeRes);
            return;
        }

        console.log("upload complete", { rcpt, targetId, file_id: getUrlRes.file_id });
    } catch (e) {
        console.error("handleSlackForward crashed", e);
    }
}

// ---------- Slack helpers ----------

async function openDmChannel(token, userId) {
    const res = await slackJson("conversations.open", token, { users: userId });
    if (!res.ok) {
        console.error("conversations.open failed:", res);
        return null;
    }
    return res.channel?.id || null;
}

async function slackForm(method, token, fields) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);

    const res = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
    });

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); }
    catch { return { ok: false, error: "non_json_response", httpStatus: res.status, body: text.slice(0, 500) }; }

    if (!json.ok) return { ok: false, error: json.error, httpStatus: res.status, response: json };
    return { ok: true, ...json };
}

async function slackJson(method, token, bodyObj) {
    const res = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(bodyObj ?? {}),
    });

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); }
    catch { return { ok: false, error: "non_json_response", httpStatus: res.status, body: text.slice(0, 500) }; }

    if (!json.ok) return { ok: false, error: json.error, httpStatus: res.status, response: json };
    return { ok: true, ...json };
}

// ---------- routing helpers ----------

function getPrimaryRecipient(message) {
    const to = message.to;
    const raw = Array.isArray(to) ? to[0] : to;

    if (typeof raw === "string") {
        const m = raw.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
        if (m) return m[1].toLowerCase();
    }

    const h = message.headers?.get?.("to");
    if (h) {
        const m = h.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
        if (m) return m[1].toLowerCase();
    }

    return "unknown@unknown";
}

function buildFilename(subject) {
    const safeSubject = (subject || "no-subject")
        .slice(0, 80)
        .replace(/[^a-z0-9]+/gi, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase();

    return `email-${Date.now()}-${safeSubject || "no_subject"}.eml`;
}

function safeJson(str, fallback) {
    try { return str ? JSON.parse(str) : fallback; } catch { return fallback; }
}

async function getRawEmailBytes(message) {
    const raw = message.raw;

    if (raw instanceof Uint8Array) return raw;
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);

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

    const ab = await new Response(raw).arrayBuffer();
    return new Uint8Array(ab);
}

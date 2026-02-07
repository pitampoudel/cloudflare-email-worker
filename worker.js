const FALLBACK_CHANNEL_NAME = "fallback-email-inbox"; // hardcoded catch-all

export default {
    async email(message, env, ctx) {
        const token = env.SLACK_BOT_TOKEN;
        if (!token) {
            console.error("Missing SLACK_BOT_TOKEN");
            return; // NEVER reject email
        }

        const routes = safeJson(env.ROUTES_JSON, {});
        const rcpt = getPrimaryRecipient(message);

        // Decide route (fallback if missing)
        let route = routes[rcpt];
        if (!route) {
            route = { type: "channel", name: FALLBACK_CHANNEL_NAME };
            console.warn("No route found; using fallback channel", {
                rcpt,
                fallback: FALLBACK_CHANNEL_NAME,
            });
        }

        ctx.waitUntil(handleSlackForward(message, token, rcpt, route));
    },
};

async function handleSlackForward(message, token, rcpt, route) {
    try {
        let targetId = null;

        if (route.type === "dm") {
            targetId = await openDmChannel(token, route.user);
            if (!targetId) {
                console.error("Failed to open DM", { rcpt, user: route.user });
                return;
            }
        } else if (route.type === "channel") {
            targetId = await resolveChannelTarget(token, route);
            if (!targetId) {
                console.error(
                    "Failed to resolve channel target. " +
                    "If this is a private channel, invite the bot to the channel and/or set route.id (channel ID).",
                    { rcpt, route }
                );
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

// ---------- NEW: channel target resolver ----------

async function resolveChannelTarget(token, route) {
    // If they provide an ID, accept it
    if (route.id && /^[CG][A-Z0-9]+$/.test(route.id)) return route.id;

    // Prefer name
    const name = sanitizeChannelName(route.name || route.channel || route.slug || "");
    if (!name) {
        console.error("Channel route missing name or valid id", { route });
        return null;
    }

    // Find or create by name
    return await ensureChannelByName(token, name);
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

async function ensureChannelByName(token, name) {
    const existing = await findChannelByName(token, name);
    if (existing) return existing;

    const created = await slackJson("conversations.create", token, { name });
    if (!created.ok) {
        console.error("conversations.create failed (maybe restricted perms):", created);
        return null;
    }
    return created.channel?.id || null;
}

async function findChannelByName(token, name) {
    let cursor;

    while (true) {
        const res = await slackJson("conversations.list", token, {
            limit: 200,
            cursor,
            types: "public_channel,private_channel",
            exclude_archived: true,
        });

        if (!res.ok) {
            console.error("conversations.list failed:", res);
            return null;
        }

        // NOTE: Slack will only return private channels the bot is a member of.
        const ch = (res.channels || []).find((c) => c?.name === name);
        if (ch?.id) return ch.id;

        cursor = res.response_metadata?.next_cursor;
        if (!cursor) break;
    }

    return null;
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
    try {
        json = JSON.parse(text);
    } catch {
        return { ok: false, error: "non_json_response", httpStatus: res.status, body: text.slice(0, 500) };
    }

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
    try {
        json = JSON.parse(text);
    } catch {
        return { ok: false, error: "non_json_response", httpStatus: res.status, body: text.slice(0, 500) };
    }

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

function sanitizeChannelName(name) {
    // Accept "#support" or "support"
    return (name || "")
        .toLowerCase()
        .trim()
        .replace(/^#/, "")
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-_]/g, "")
        .slice(0, 80);
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
    try {
        return str ? JSON.parse(str) : fallback;
    } catch {
        return fallback;
    }
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

/**
 * Cloudflare Email Worker → Slack forwarder
 * - Parses MIME with postal-mime
 * - Posts a readable preview (blocks)
 * - Uploads full body as .txt + optional raw .eml archive
 */

import PostalMime from "postal-mime";

const FALLBACK_CHANNEL_NAME = "fallback-email-inbox";

// Slack / blocks constraints (keep conservative)
const SLACK_BLOCK_TEXT_LIMIT = 3000; // Slack is ~3000 chars for mrkdwn text
const SLACK_PREVIEW_LIMIT = 2500; // keep room for header/labels
const SLACK_ATTACHMENTS_LIST_LIMIT = 10;

const DEFAULT_OPTIONS = {
    uploadTxtBody: true,
    uploadRawEml: true,
    stripPlusAddressing: false, // set true if you want user+tag@domain.com → user@domain.com
    // If true, tries to create channels by name (requires perms). If false, only resolves existing.
    allowCreatePublicChannels: true,
};

export default {
    async email(message, env, ctx) {
        try {
            const token = env.SLACK_BOT_TOKEN;
            if (!token) {
                console.error("Missing SLACK_BOT_TOKEN");
                return; // NEVER reject email
            }

            const routes = safeJson(env.ROUTES_JSON, {});
            const options = { ...DEFAULT_OPTIONS, ...safeJson(env.OPTIONS_JSON, {}) };

            const rcpt = getPrimaryRecipient(message, { stripPlusAddressing: options.stripPlusAddressing });

            const route = normalizeRoute(routes?.[rcpt]) ?? {
                type: "channel",
                name: FALLBACK_CHANNEL_NAME,
            };

            if (!routes?.[rcpt]) {
                console.warn("No route found; using fallback channel", { rcpt, fallback: FALLBACK_CHANNEL_NAME });
            }

            ctx.waitUntil(handleSlackForward({ message, token, rcpt, route, options }));
        } catch (e) {
            // never bounce
            console.error("Email handler crashed", e);
        }
    },
};

/**
 * Main forward flow:
 * 1) Resolve target channel ID
 * 2) Parse raw email bytes with postal-mime
 * 3) Post preview blocks
 * 4) Upload body .txt (optional)
 * 5) Upload raw .eml (optional)
 */
async function handleSlackForward({ message, token, rcpt, route, options }) {
    const cache = new Map(); // per-request cache
    try {
        const targetId = await resolveSlackTargetId(token, route, { cache, options });
        if (!targetId) return;

        const rawBytes = await getRawEmailBytes(message);

        const subject = headerOr(message, "subject", "no-subject");
        const from = message.from || headerOr(message, "from", "unknown");
        const toHeader = headerOr(message, "to", rcpt);

        const parsed = await safeParseMime(rawBytes);

        const bodyText = extractBestText(parsed);
        const bodyPreview = bodyText
            ? clampSlackMrkdwn(bodyText, SLACK_PREVIEW_LIMIT)
            : "_(No readable body found.)_";

        const blocks = buildSlackBlocks({
            toHeader,
            from,
            subject,
            bodyPreview,
            attachments: parsed?.attachments,
        });

        const postRes = await slackApiJson(token, "chat.postMessage", {
            channel: targetId,
            text: `New email: ${subject}`, // fallback text
            blocks,
            unfurl_links: false,
            unfurl_media: false,
        });

        if (!postRes.ok) {
            console.error("chat.postMessage failed:", postRes);
            // Continue; uploads can still succeed.
        }

        // Upload full body as .txt (optional)
        if (options.uploadTxtBody && bodyText?.trim()) {
            const bodyFilename = `email-body-${Date.now()}.txt`;
            const bodyBytes = new TextEncoder().encode(bodyText);

            await uploadBytesToSlack(token, targetId, bodyFilename, bodyBytes, {
                initial_comment: "Full email body (viewable in Slack):",
            });
        }

        // Upload raw .eml archive (optional)
        if (options.uploadRawEml) {
            const emlFilename = buildEmlFilename(subject);
            await uploadBytesToSlack(token, targetId, emlFilename, rawBytes, {
                initial_comment: "Raw email archive (.eml):",
            });
        }

        console.log("email forwarded", { rcpt, targetId });
    } catch (e) {
        console.error("handleSlackForward crashed", e);
    }
}

/* -------------------------- Slack Target Resolution -------------------------- */

async function resolveSlackTargetId(token, route, { cache, options }) {
    const type = route?.type;

    if (type === "dm") {
        const userId = route.user;
        if (!userId) {
            console.error("DM route missing user", route);
            return null;
        }
        return await openDmChannel(token, userId);
    }

    if (type === "channel") {
        // Prefer explicit channel ID (recommended for private channels)
        if (route.id && /^[CG][A-Z0-9]+$/.test(route.id)) return route.id;

        const name = sanitizeChannelName(route.name || route.channel || route.slug || "");
        if (!name) {
            console.error("Channel route missing name or valid id", { route });
            return null;
        }

        return await ensureChannelByName(token, name, { cache, allowCreate: options.allowCreatePublicChannels });
    }

    console.error("Invalid route type:", type);
    return null;
}

async function openDmChannel(token, userId) {
    const res = await slackApiJson(token, "conversations.open", { users: userId });
    if (!res.ok) {
        console.error("conversations.open failed:", res);
        return null;
    }
    return res.channel?.id || null;
}

async function ensureChannelByName(token, name, { cache, allowCreate }) {
    const cacheKey = `channel:${name}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    const existing = await findChannelByName(token, name);
    if (existing) {
        cache.set(cacheKey, existing);
        return existing;
    }

    if (!allowCreate) {
        console.error("Channel not found and creation disabled", { name });
        cache.set(cacheKey, null);
        return null;
    }

    const created = await slackApiJson(token, "conversations.create", { name });
    if (!created.ok) {
        console.error("conversations.create failed (maybe restricted perms):", created);
        cache.set(cacheKey, null);
        return null;
    }

    const id = created.channel?.id || null;
    cache.set(cacheKey, id);
    return id;
}

async function findChannelByName(token, name) {
    let cursor;

    while (true) {
        const res = await slackApiJson(token, "conversations.list", {
            limit: 200,
            cursor,
            types: "public_channel,private_channel",
            exclude_archived: true,
        });

        if (!res.ok) {
            console.error("conversations.list failed:", res);
            return null;
        }

        const ch = (res.channels || []).find((c) => c?.name === name);
        if (ch?.id) return ch.id;

        cursor = res.response_metadata?.next_cursor;
        if (!cursor) break;
    }

    return null;
}

/* -------------------------- Slack Posting / Upload --------------------------- */

/**
 * Robust Slack API JSON wrapper:
 * - Handles non-JSON, Slack errors
 * - Retries on rate-limit / transient errors
 */
async function slackApiJson(token, method, bodyObj, { retries = 2 } = {}) {
    const url = `https://slack.com/api/${method}`;

    for (let attempt = 0; attempt <= retries; attempt++) {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json; charset=utf-8",
            },
            body: JSON.stringify(bodyObj ?? {}),
        });

        // Rate-limited
        if (res.status === 429 && attempt < retries) {
            const retryAfter = Number(res.headers.get("retry-after") || "1");
            await sleep(Math.min(Math.max(retryAfter, 1), 10) * 1000);
            continue;
        }

        const text = await res.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch {
            return { ok: false, error: "non_json_response", httpStatus: res.status, body: text.slice(0, 500) };
        }

        if (!json.ok) {
            // Retry some transient Slack errors
            if (attempt < retries && isRetryableSlackError(json.error)) {
                await sleep(600 * (attempt + 1));
                continue;
            }
            return { ok: false, error: json.error, httpStatus: res.status, response: json };
        }

        return { ok: true, ...json };
    }

    return { ok: false, error: "retries_exhausted" };
}

async function slackApiForm(token, method, fields, { retries = 2 } = {}) {
    const url = `https://slack.com/api/${method}`;

    for (let attempt = 0; attempt <= retries; attempt++) {
        const form = new FormData();
        for (const [k, v] of Object.entries(fields)) form.append(k, v);

        const res = await fetch(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: form,
        });

        if (res.status === 429 && attempt < retries) {
            const retryAfter = Number(res.headers.get("retry-after") || "1");
            await sleep(Math.min(Math.max(retryAfter, 1), 10) * 1000);
            continue;
        }

        const text = await res.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch {
            return { ok: false, error: "non_json_response", httpStatus: res.status, body: text.slice(0, 500) };
        }

        if (!json.ok) {
            if (attempt < retries && isRetryableSlackError(json.error)) {
                await sleep(600 * (attempt + 1));
                continue;
            }
            return { ok: false, error: json.error, httpStatus: res.status, response: json };
        }

        return { ok: true, ...json };
    }

    return { ok: false, error: "retries_exhausted" };
}

/**
 * External upload flow:
 * 1) files.getUploadURLExternal
 * 2) POST bytes to upload_url
 * 3) files.completeUploadExternal
 */
async function uploadBytesToSlack(token, channelId, filename, bytes, { initial_comment } = {}) {
    const length = bytes?.byteLength ?? 0;
    if (!length) return false;

    const getUrlRes = await slackApiForm(token, "files.getUploadURLExternal", {
        filename,
        length: String(length),
    });

    if (!getUrlRes.ok) {
        console.error("files.getUploadURLExternal failed:", getUrlRes);
        return false;
    }

    const uploadRes = await fetch(getUrlRes.upload_url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
    });

    if (!uploadRes.ok) {
        const t = await uploadRes.text().catch(() => "");
        console.error("Upload failed:", uploadRes.status, t.slice(0, 500));
        return false;
    }

    const completeRes = await slackApiForm(token, "files.completeUploadExternal", {
        files: JSON.stringify([{ id: getUrlRes.file_id, title: filename }]),
        channel_id: channelId,
        ...(initial_comment ? { initial_comment } : {}),
    });

    if (!completeRes.ok) {
        console.error("files.completeUploadExternal failed:", completeRes);
        return false;
    }

    return true;
}

/* -------------------------- Email Parse / Blocks ----------------------------- */

async function safeParseMime(rawBytes) {
    try {
        return await new PostalMime().parse(rawBytes);
    } catch (e) {
        console.error("PostalMime parse failed", e);
        return { text: "", html: "", attachments: [] };
    }
}

function extractBestText(parsed) {
    const text = parsed?.text?.trim();
    if (text) return text;

    const html = parsed?.html?.trim();
    if (html) return htmlToText(html);

    return "";
}

function buildSlackBlocks({ toHeader, from, subject, bodyPreview, attachments }) {
    const blocks = [
        {
            type: "header",
            text: { type: "plain_text", text: "📧 New email", emoji: true },
        },
        {
            type: "section",
            fields: [
                { type: "mrkdwn", text: `*To:*\n${escapeSlackMrkdwn(toHeader)}`.slice(0, SLACK_BLOCK_TEXT_LIMIT) },
                { type: "mrkdwn", text: `*From:*\n${escapeSlackMrkdwn(from)}`.slice(0, SLACK_BLOCK_TEXT_LIMIT) },
                { type: "mrkdwn", text: `*Subject:*\n${escapeSlackMrkdwn(subject)}`.slice(0, SLACK_BLOCK_TEXT_LIMIT) },
            ],
        },
        { type: "divider" },
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: `*Preview:*\n${bodyPreview}`.slice(0, SLACK_BLOCK_TEXT_LIMIT),
            },
        },
    ];

    if (Array.isArray(attachments) && attachments.length) {
        const attLines = attachments
            .slice(0, SLACK_ATTACHMENTS_LIST_LIMIT)
            .map((a, i) => `• ${i + 1}. ${a.filename || "attachment"} (${a.mimeType || "unknown"}, ${a.size ?? "?"} bytes)`)
            .join("\n");

        blocks.push({ type: "divider" });
        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: `*Attachments (${attachments.length}):*\n${escapeSlackMrkdwn(attLines)}`.slice(0, SLACK_BLOCK_TEXT_LIMIT),
            },
        });
    }

    return blocks;
}

/* -------------------------- Routing / Config -------------------------------- */

function normalizeRoute(route) {
    if (!route || typeof route !== "object") return null;

    const type = String(route.type || "").toLowerCase();
    if (type === "dm") {
        return route.user ? { type: "dm", user: String(route.user) } : null;
    }

    if (type === "channel") {
        return {
            type: "channel",
            id: route.id ? String(route.id) : undefined,
            name: route.name || route.channel || route.slug ? String(route.name || route.channel || route.slug) : undefined,
        };
    }

    return null;
}

function safeJson(str, fallback) {
    try {
        return str ? JSON.parse(str) : fallback;
    } catch {
        return fallback;
    }
}

/* -------------------------- Headers / Recipient ------------------------------ */

function headerOr(message, headerName, fallback) {
    const v = message?.headers?.get?.(headerName);
    return v || fallback;
}

/**
 * Picks a primary recipient.
 * - Uses message.to first
 * - Falls back to To header
 * - Optionally strips plus addressing
 */
function getPrimaryRecipient(message, { stripPlusAddressing } = {}) {
    const all = [];

    // message.to can be string or array; Cloudflare Email Workers vary
    const to = message?.to;
    if (Array.isArray(to)) all.push(...to);
    else if (to) all.push(to);

    const toHeader = message?.headers?.get?.("to");
    if (toHeader) all.push(toHeader);

    const found = extractFirstEmail(all.join(", "));
    if (!found) return "unknown@unknown";

    return (stripPlusAddressing ? stripPlus(found) : found).toLowerCase();
}

function extractFirstEmail(s) {
    const m = String(s || "").match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
    return m ? m[1] : null;
}

function stripPlus(email) {
    // user+tag@domain.com -> user@domain.com
    const m = String(email).match(/^([^@+]+)(?:\+[^@]+)?@(.+)$/);
    return m ? `${m[1]}@${m[2]}` : email;
}

/* -------------------------- Raw Email Bytes ---------------------------------- */

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

/* -------------------------- Text / Safety Utilities -------------------------- */

function clampSlackMrkdwn(text, maxChars) {
    const t = (text || "").trim();
    if (!t) return "";
    const safe = escapeSlackMrkdwn(t);
    if (safe.length <= maxChars) return safe;
    return safe.slice(0, Math.max(0, maxChars - 1)) + "…";
}

/**
 * Slack mrkdwn escaping:
 * - & < > must be escaped
 * - also escape backticks to avoid codeblock breakage
 */
function escapeSlackMrkdwn(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/`/g, "ˋ");
}

function sanitizeChannelName(name) {
    return (name || "")
        .toLowerCase()
        .trim()
        .replace(/^#/, "")
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-_]/g, "")
        .slice(0, 80);
}

function buildEmlFilename(subject) {
    const safeSubject = (subject || "no-subject")
        .slice(0, 80)
        .replace(/[^a-z0-9]+/gi, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase();

    return `email-${Date.now()}-${safeSubject || "no_subject"}.eml`;
}

function htmlToText(html) {
    return String(html || "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function isRetryableSlackError(error) {
    // Common transient errors; extend as needed
    return new Set([
        "ratelimited",
        "timeout",
        "internal_error",
        "service_unavailable",
        "fatal_error",
    ]).has(String(error || "").toLowerCase());
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
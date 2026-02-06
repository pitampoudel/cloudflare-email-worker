export default {
  async email(message, env, ctx) {
    const token = env.SLACK_BOT_TOKEN;
    if (!token) {
      console.error("Missing SLACK_BOT_TOKEN");
      return;
    }

    const routes = safeJson(env.ROUTES_JSON, {});
    const rcpt = getPrimaryRecipient(message); // normalized email like support@vardansoft.com

    // Decide target
    const route = routes[rcpt];
    if (!route) {
      message.setReject(`550 5.1.1 No such recipient: ${rcpt}`);
      return;
    }

    // Resolve Slack channel_id (channel or DM)
    let channelId;
    if (route.type === "channel") {
      channelId = route.id;
    } else if (route.type === "dm") {
      channelId = await openDmChannel(token, route.user);
      if (!channelId) return;
    } else {
      console.error("Invalid route type:", route);
      return;
    }

    // Prepare file
    const rawBytes = await getRawEmailBytes(message);
    const length = rawBytes.byteLength;

    const subject = message.headers.get("subject") || "no-subject";
    const from = message.from || "unknown";
    const filename = buildFilename(subject);

    // Upload flow
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
      console.error("Upload to upload_url failed:", uploadRes.status, t.slice(0, 500));
      return;
    }

    const comment = `📧 *New email*\n*To:* ${rcpt}\n*From:* ${from}\n*Subject:* ${subject}`;

    const completeRes = await slackForm("files.completeUploadExternal", token, {
      files: JSON.stringify([{ id: getUrlRes.file_id, title: filename }]),
      channel_id: channelId,
      initial_comment: comment,
    });

    if (!completeRes.ok) {
      console.error("files.completeUploadExternal failed:", completeRes);
      return;
    }
  },
};

// ---------- routing helpers ----------

function getPrimaryRecipient(message) {
  // Cloudflare Email Worker exposes rcpt in event, but easiest is message.to if present.
  // message.to can be string or array depending on runtime.
  const to = message.to;

  // Try to find something like "Name <email@domain>" or plain "email@domain"
  const raw = Array.isArray(to) ? to[0] : to;
  if (typeof raw === "string") {
    const m = raw.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
    if (m) return m[1].toLowerCase();
  }

  // Fallback: if your runtime includes headers "to"
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

// ---------- Slack helpers ----------

async function openDmChannel(token, userId) {
  // Opens (or returns existing) DM channel with a user
  // Needs scope: im:write (and sometimes conversations:write depending on workspace)
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
  return json;
}

async function slackJson(method, token, bodyObj) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(bodyObj),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { return { ok: false, error: "non_json_response", httpStatus: res.status, body: text.slice(0, 500) }; }

  if (!json.ok) return { ok: false, error: json.error, httpStatus: res.status, response: json };
  return json;
}

// ---------- Email raw bytes helper ----------

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

export default {
  async email(message, env, ctx) {
    const slackToken = env.SLACK_BOT_TOKEN;
    const slackChannel = env.SLACK_CHANNEL_ID;

    // ✅ Get raw email bytes (Cloudflare Email Worker compatible)
    const rawEmailBytes = await getRawEmailBytes(message);

    const subject = message.headers.get("subject") || "no-subject";
    const safeSubject = subject
      .slice(0, 80)
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();

    const filename = `email-${Date.now()}-${safeSubject || "no_subject"}.eml`;

    const from = message.from || "unknown";

    const form = new FormData();
    form.append("channels", slackChannel);
    form.append("filename", filename);
    form.append("title", subject.slice(0, 150));
    form.append("initial_comment", `📧 New email from *${from}*\n*Subject:* ${subject}`);

    // Slack expects a File/Blob; set content-type to RFC822 for email
    form.append(
      "file",
      new Blob([rawEmailBytes], { type: "message/rfc822" }),
      filename
    );

    const res = await fetch("https://slack.com/api/files.upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${slackToken}` },
      body: form,
    });

    const bodyText = await res.text();
    let result;
    try {
      result = JSON.parse(bodyText);
    } catch {
      console.error("Slack response not JSON:", res.status, bodyText.slice(0, 500));
      return;
    }

    if (!res.ok || !result.ok) {
      console.error("Slack upload failed:", {
        httpStatus: res.status,
        slackError: result.error,
        response: result,
      });
    }
  },
};

// ---- helpers ----

async function getRawEmailBytes(message) {
  // Cloudflare Email Workers commonly provide `message.raw` as:
  // - Uint8Array / ArrayBuffer
  // - ReadableStream
  // - string (RFC822)
  const raw = message.raw;

  // Uint8Array
  if (raw instanceof Uint8Array) return raw;

  // ArrayBuffer
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);

  // ReadableStream
  if (raw && typeof raw.getReader === "function") {
    return await readStreamToUint8Array(raw);
  }

  // String
  if (typeof raw === "string") {
    return new TextEncoder().encode(raw);
  }

  // Fallback: try to construct a Response (works if raw is stream-like)
  try {
    const ab = await new Response(raw).arrayBuffer();
    return new Uint8Array(ab);
  } catch (e) {
    console.error("Unknown message.raw type:", typeof raw, raw);
    throw e;
  }
}

async function readStreamToUint8Array(stream) {
  const reader = stream.getReader();
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

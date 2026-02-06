export default {
  async email(message, env, ctx) {
    const slackToken = env.SLACK_BOT_TOKEN;
    const slackChannel = env.SLACK_CHANNEL_ID;

    if (!slackToken || !slackChannel) {
      console.error("Missing SLACK_BOT_TOKEN or SLACK_CHANNEL_ID");
      return;
    }

    // Get raw email bytes
    const rawEmail = await message.raw.arrayBuffer();

    // Subject + safe filename (limit length to avoid Slack/FS weirdness)
    const subject = message.headers.get("subject") || "no-subject";
    const safeSubject = subject
      .slice(0, 80)
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();

    const filename = `email-${Date.now()}-${safeSubject || "no_subject"}.eml`;

    // Optional: add a small metadata text file too (sometimes helpful)
    const from = message.from || "unknown";
    const to = (message.to && Array.isArray(message.to)) ? message.to.join(", ") : (message.to || "");
    const date = message.headers.get("date") || "";
    const meta = `From: ${from}\nTo: ${to}\nDate: ${date}\nSubject: ${subject}\n`;

    // Create multipart form for Slack
    const form = new FormData();
    form.append("channels", slackChannel);
    form.append("filename", filename);
    form.append("title", subject.slice(0, 150));
    form.append("initial_comment", `📧 New email from *${from}*\n*Subject:* ${subject}`);
    form.append("file", new Blob([rawEmail], { type: "message/rfc822" }), filename);

    // (Optional) attach meta as a second file instead of (or in addition to) initial_comment
    // Slack classic files.upload supports one file per call; if you want both, do a second upload.
    // Leaving meta unused for now, but you can upload it with another call if you want.

    const res = await fetch("https://slack.com/api/files.upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${slackToken}` },
      body: form,
    });

    const text = await res.text(); // read as text first to debug invalid JSON / HTML errors
    let result;
    try {
      result = JSON.parse(text);
    } catch (e) {
      console.error("Slack response not JSON:", res.status, text.slice(0, 500));
      return;
    }

    if (!res.ok || !result.ok) {
      console.error("Slack upload failed:", {
        httpStatus: res.status,
        slackOk: result.ok,
        slackError: result.error,
        response: result,
      });

      // Common actionable hints
      if (result.error === "missing_scope") {
        console.error("Fix: ensure bot token has files:write (and chat:write if posting messages).");
      }
      if (result.error === "channel_not_found") {
        console.error("Fix: ensure SLACK_CHANNEL_ID is a conversation ID like C..., and bot is in the channel.");
      }
      if (result.error === "not_in_channel") {
        console.error("Fix: invite the bot to the channel (especially private channels).");
      }
    }
  },
};

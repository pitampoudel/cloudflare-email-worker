import {EmailMessage} from "cloudflare:email";

export default {
    async email(message, env, ctx) {

        const routes = safeJson(env.ROUTES_JSON, {});
        let routeConfig = routes[message.to];
        if (!routeConfig) {
            routeConfig = routes["fallback"];
        }
        const forwardToTargets = routeConfig?.forwardTo;

        if (!forwardToTargets || forwardTargets.length === 0) message.setReject("Unknown addresses");


        if (env.SLACK_BOT_TOKEN && routeConfig.slack) {
            ctx.waitUntil(slackPost(env.SLACK_BOT_TOKEN, "chat.postMessage", {
                channel: resolveSlackTarget(routeConfig, env.SLACK_BOT_TOKEN),
                "text": `Got an email from ${message.from}, subject: ${message.headers.get('subject')}`
            }));
        }

        try {
            message.forward(forwardTo);

        } catch (e) {
            // send using different from address


            // if still fails, reject the message
            message.setReject("Unable to forward this email");

        }

    },
};


async function resolveSlackTarget(routeConfig, token) {
    const slack = routeConfig.slack;
    if (!slack) {
        return null;
    }
    const type = routeConfig.type;
    if (type !== "dm" || slack.startsWith("D")) {
        return slack;
    }

    const opened = await slackPost(token, "conversations.open", {users: slack});
    if (!opened.ok) {
        throw new Error(`conversations.open failed: ${opened.error || "unknown_error"}`);
    }
    return opened.channel?.id;
}


function safeJson(str, fallback) {
    try {
        return str ? JSON.parse(str) : fallback;
    } catch {
        return fallback;
    }
}

async function slackPost(token, endpoint, payload) {
    const response = await fetch(`https://slack.com/api/${endpoint}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(payload),
    });
    const text = await response.text();
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = {ok: false, error: "non_json_response"};
    }

    if (!response.ok && parsed.ok !== false) {
        parsed.ok = false;
        parsed.error = `http_${response.status}`;
    }
    return parsed;
}
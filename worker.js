export default {
    async email(message, env, ctx) {
        const routes = safeJson(env.ROUTES_JSON, {});
        const routeConfig = resolveRouteConfig(routes, message.to);
        if (!routeConfig) {
            message.setReject("Unknown address");
            return;
        }

        const forwardToTargets = routeConfig.forwardTo;
        if (!forwardToTargets || forwardToTargets.length === 0) {
            message.setReject("Unknown address");
            return;
        }

        if (env.SLACK_BOT_TOKEN && routeConfig.slack) {
            ctx.waitUntil(notifySlack(message, routeConfig, env.SLACK_BOT_TOKEN));
        }

        let hadForwardFailure = false;

        for (const target of forwardToTargets) {
            try {
                await message.forward(target);
            } catch (error) {
                hadForwardFailure = true;
                try {
                    const rewrittenHeaders = new Headers();
                    rewrittenHeaders.set("From", routes.forwarder);
                    rewrittenHeaders.set("Reply-To", message.from);
                    await message.forward(target, rewrittenHeaders);
                } catch (retryError) {
                    console.error("Forwarding failed", {
                        target,
                        error: normalizeError(error),
                        retryError: normalizeError(retryError),
                    });
                    message.setReject("Unable to forward this email");
                    return;
                }
            }
        }

        if (hadForwardFailure) {
            console.warn("Forward succeeded after retry with rewritten From header", {
                from: message.from
            });
        }
    },
};


async function notifySlack(message, routeConfig, token) {
    try {
        const channel = await resolveSlackTarget(routeConfig, token);
        if (!channel) {
            return;
        }

        const subject = message.headers.get("subject") || "(no subject)";
        const posted = await slackPost(token, "chat.postMessage", {
            channel,
            text: `Got an email from ${message.from}, to ${message.to}, subject: ${subject}`,
        });

        if (!posted.ok) {
            console.error("chat.postMessage failed", posted.error || "unknown_error");
        }
    } catch (error) {
        console.error("Slack notification failed", error);
    }
}

function resolveRouteConfig(routes, toAddress) {
    if (!routes || typeof routes !== "object") {
        return null;
    }

    const normalizedTo = normalizeAddress(toAddress);
    for (const [key, value] of Object.entries(routes)) {
        if (key === "fallback") {
            continue;
        }
        if (normalizeAddress(key) === normalizedTo) {
            return value;
        }
    }
    return routes.fallback || null;
}

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

function normalizeAddress(address) {
    return `${address || ""}`.trim().toLowerCase();
}

function normalizeError(error) {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
        };
    }
    return {message: `${error}`};
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

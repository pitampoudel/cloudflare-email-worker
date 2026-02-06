# Cloudflare Email Forwarder to Slack

A Cloudflare Email Worker that forwards incoming emails to Slack channels or direct messages.

## Setup

### 1. Configure Environment Variables

Before deploying, set up the required environment variables:

#### Set Slack Bot Token (Secret)
```bash
npx wrangler secret put SLACK_BOT_TOKEN
```
Enter your Slack bot token when prompted.

#### Set Email Routing Configuration
```bash
npx wrangler secret put ROUTES_JSON
```
Enter your routing JSON when prompted (see example below).

Alternatively, you can set these variables in the Cloudflare dashboard:
- Go to Workers & Pages > Your Worker > Settings > Variables
- Add `SLACK_BOT_TOKEN` as an encrypted variable
- Add `ROUTES_JSON` as an encrypted variable

### 2. Deploy

With the `wrangler.toml` configuration file, simply run:
```bash
npx wrangler deploy
```

The wrangler.toml file ensures your environment variables are preserved across deployments.

### ROUTES_JSON Format Example
```json
{
  "ceo@yourcompany.com": {
    "type": "dm",
    "user": "U06TDCJGP4H"
  },
  "support@yourcompany.com": {
    "id": "C06SXQKQC2H",
    "type": "channel"
  }
}
```



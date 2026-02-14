# Cloudflare Email Forwarder

A Cloudflare Email Worker that posts incoming-email notifications to Slack channels or direct messages and forwards emails to specified addresses.

When forwarding an email, keeping the original sender's email address in the "From" field fails due to email spoofing protections. The worker will forward the email with a modified "From" address

## Setup

### 1. Configure Environment Variables

#### Set Slack Bot Token (Secret, Optional)
```bash
npx wrangler secret put SLACK_BOT_TOKEN
```
Enter your Slack bot token when prompted.

#### Set Email Routing Configuration
```bash
npx wrangler secret put ROUTES_JSON
```
Enter your routing JSON when prompted (see example below).

### 2. Deploy

With the `wrangler.toml` configuration file, simply run:
```bash
npx wrangler deploy
```

### ROUTES_JSON Format Example
```json
{
  "fallback": {
    "type": "channel",
    "slack": "C06SXQKQC2H",
    "forwardTo": ["team@example.com"]
  },
  "ceo@yourcompany.com": {
    "type": "dm",
    "slack": "U06TDCJGP4H",
    "forwardTo": ["ceo-personal@example.com"]
  },
  "support@yourcompany.com": {
    "type": "channel",
    "slack": "C06SXQKQC2H",
    "forwardTo": ["support-team@example.com"]
  }
}
```
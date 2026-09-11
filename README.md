# treq-slack-relay

Cloudflare Worker that verifies Slack Events, acks fast, and forwards `@Treq` mentions / DMs to the Treq Grok Bot webhook.

## Runtime

- **Prod:** Cloudflare Workers (`treq-slack-relay`)
- **Not** Socket Mode, not local hosting

## Secrets

```bash
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put GROK_WEBHOOK_URL
npx wrangler secret put GROK_WEBHOOK_AUTHORIZATION
# optional:
# npx wrangler secret put SLACK_BOT_USER_ID
```

`GROK_WEBHOOK_AUTHORIZATION` is the full `Authorization` header value from the Treq Slack webhook routine.

## Deploy

```bash
npm install
npx wrangler deploy
```

## Slack app

1. Event Subscriptions Request URL = `https://treq-slack-relay.<account>.workers.dev/`
2. Subscribe: `app_mention`, `message.im`
3. Disable Socket Mode for production HTTP events
4. Bot scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `channels:history`, `groups:history`, `mpim:history`, `users:read`

Replies as `@Treq` use the bot token from Treq (Grok Bot), not this Worker.

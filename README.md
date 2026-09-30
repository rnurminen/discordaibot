# Status RSS Discord bot

Posts new and updated incidents from the Claude, Cursor, and OpenAI status feeds to one Discord channel.

## Setup

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications) and add a bot. Copy the bot token.
2. Invite the bot to your server with the `bot` scope and the Send Messages permission. Under **Bot → Privileged Gateway Intents**, turn on **Message Content Intent**. The bot needs that to see `!aistatus`.
3. Turn on Developer Mode in Discord, then copy the target channel id.
4. Install and configure:

```bash
cp .env.example .env
# set DISCORD_TOKEN and DISCORD_CHANNEL_ID
npm install
npm start
```

The first successful fetch of each feed is recorded in `data/state.json`. Later polls post incidents that are new or whose update text changed. A restart keeps that record, so already-seen incidents stay quiet.

In the status channel, `!aistatus` replies with the latest incident from Claude, Cursor, and OpenAI.

`POLL_INTERVAL_MS` defaults to 60000. Each feed waits longer when its `Cache-Control: max-age` is longer than that. On HTTP 429 or 503, that feed waits for `Retry-After` when the server sends it, or for `RateLimit-Reset` / `X-RateLimit-Reset` when the remaining quota is zero. With none of those headers, the feed backs off exponentially up to 15 minutes. The other feeds keep their own schedule.

## Feeds

- https://status.claude.com/history.rss
- https://status.cursor.com/history.rss
- https://status.openai.com/feed.rss

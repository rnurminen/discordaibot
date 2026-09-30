# Status RSS Discord bot

Posts new and updated incidents from the Claude, Cursor, and OpenAI status feeds to one Discord channel.

## Setup

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications) and add a bot. Copy the bot token.
2. Invite the bot to your server with the `bot` scope and the Send Messages permission. Under **Bot → Privileged Gateway Intents**, turn on **Message Content Intent**. The bot needs that to see `!aistatus` and `!roast`. For the chat channel, also allow View Channel and Read Message History.
3. Turn on Developer Mode in Discord, then copy the status channel id. Copy a second channel id if you want roasts.
4. Install and configure:

```bash
cp .env.example .env
# set DISCORD_TOKEN and DISCORD_STATUS_CHANNEL_ID
# for roasts, also set DISCORD_CHAT_CHANNEL_ID and GEMINI_API_KEY
npm install
npm start
```

The first successful fetch of each feed is recorded in `data/state.json`. Later polls post incidents that are new or whose update text changed. A restart keeps that record, so already-seen incidents stay quiet.

In the status channel, `!aistatus` replies with the latest incident from Claude, Cursor, and OpenAI.

`POLL_INTERVAL_MS` defaults to 60000. Each feed waits longer when its `Cache-Control: max-age` is longer than that. On HTTP 429 or 503, that feed waits for `Retry-After` when the server sends it, or for `RateLimit-Reset` / `X-RateLimit-Reset` when the remaining quota is zero. With none of those headers, the feed backs off exponentially up to 15 minutes. The other feeds keep their own schedule.

## Chat roasts

`DISCORD_CHAT_CHANNEL_ID` is a second text channel. Status posts and `!aistatus` stay on `DISCORD_STATUS_CHANNEL_ID`. Leave the chat channel unset to keep the bot status-only.

In the chat channel, `!roast <username>` roasts that person from their last 3 to 10 lines. The name matches their Discord username, display name, or server nickname, ignoring case. An `@mention` counts as the name. A bot name or bot mention is refused. With no username, the bot replies with the usage.

After a roast, that person is locked until they post another 3 to 10 lines. The next roast uses those new lines, not the ones already used.

Each day the bot also posts up to two timed roasts, at random times, of people who have enough lines and have not been roasted with `!roast` that day. That day's count is kept in `data/state.json`, so a restart does not start it over.

`!gemini <prompt>` asks that question on the same Gemini model. The bot tells it to keep the answer short: a sentence or two for a simple question, a short paragraph for a broader one.

Roasts use the Gemini API free tier. Create a key in [Google AI Studio](https://aistudio.google.com/apikey) and set `GEMINI_API_KEY`. If the chat channel is set and the key is missing, the bot still starts, and `!roast` says the key is not configured. `GEMINI_MODEL` defaults to `gemini-3.5-flash`.

## Feeds

- https://status.claude.com/history.rss
- https://status.cursor.com/history.rss
- https://status.openai.com/feed.rss

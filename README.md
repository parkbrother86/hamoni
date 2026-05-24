# Hamoni

Real-time Discord chat translation relay between Korean / English / Japanese / Chinese channels. LLM-powered, latency-optimized, MMORPG-tuned.

실시간 디스코드 다국어 채팅 릴레이 봇 — 한/영/일/중 채널을 자동 번역으로 연결합니다.

## Features

- **Parallel translation** via DeepSeek API — 3 target languages translated concurrently per message
- **LRU translation cache** with TTL — repeated phrases (`ㅋㅋ`, `GG`, `AFK`) hit cache instantly
- **Translation skip detection** — emoji-only / URL-only / same-language messages bypass the API
- **Custom emoji & mention preservation** — placeholder-based round-trip protection prevents the model from mangling Discord syntax
- **Message edit / delete sync** — edits and deletes on the source propagate to all relayed channels
- **Attachment relay** — images, files, and stickers are forwarded across channels
- **Long-message handling** — messages over the length cap are relayed with a "too long to translate" notice instead of being silently dropped
- **Reply context preservation** — Discord replies show the quoted snippet in target channels
- **Jump link** — every relayed message includes a `[⤴]` link back to the source
- **Per-user rate limiting** — protects against burst abuse and API rate limits
- **`/stats` slash command** — p50/p95/p99 latency, cache hit rate, per-language-pair breakdown
- **Persistent metrics log** — JSONL append log survives restarts, daily rotation, raw data preserved for offline analysis

## Architecture

```
index.js          Entry point (Discord client, event wiring)
config.js         Channel IDs, language constants
text.js           Sanitize, normalize, mention/emoji preprocessing
translator.js     DeepSeek API + LRU cache
webhook.js        Webhook lookup/create with caching
store.js          In-memory relay ID mapping (for edit/delete sync)
relay.js          Message handler orchestration
stats.js          In-memory session counters
metrics.js        Persistent JSONL metrics log
commands.js       /stats slash command
```

## Requirements

- Node.js 18+
- A Discord bot token with the following intents: `Guilds`, `GuildMessages`, `MessageContent`
- A DeepSeek API key (https://platform.deepseek.com/)
- 4 Discord channels (one per language: KR/EN/JP/CN) in the same guild
- Bot permissions in each channel: `Send Messages`, `Manage Webhooks`, `Read Message History`, `Use Application Commands`

## Setup

1. **Clone & install**

   ```bash
   git clone https://github.com/parkbrother86/hamoni.git
   cd hamoni
   npm install
   ```

2. **Create `.env`**

   ```env
   DISCORD_TOKEN=your_discord_bot_token
   DEEPSEEK_API_KEY=your_deepseek_api_key
   ```

3. **Configure channel IDs**

   Edit [`config.js`](config.js) and replace the channel IDs in `CHANNELS` with your own:

   ```js
   const CHANNELS = {
     kr: 'YOUR_KR_CHANNEL_ID',
     en: 'YOUR_EN_CHANNEL_ID',
     jp: 'YOUR_JP_CHANNEL_ID',
     cn: 'YOUR_CN_CHANNEL_ID',
   };
   ```

4. **Run**

   ```bash
   npm start
   # or with pm2:
   pm2 start index.js --name hamoni
   pm2 logs hamoni
   ```

   On startup, the bot logs each configured channel and registers the `/stats` slash command on every guild it joins.

## Usage

Once running, the bot automatically translates and relays every message posted in any of the 4 configured channels to the other 3, via webhooks that impersonate the original user's name and avatar.

In any channel where the bot has command access:

```
/stats
```

Shows current session metrics plus 1h / 24h aggregated latency percentiles and per-language-pair breakdown.

## Customizing for non-MMORPG use

The translation system prompt in [`translator.js`](translator.js) is tuned for MMORPG chat (preserves gaming slang like GG / AFK / DPS, uses casual tone). To repurpose for other domains:

- Edit the `system` message in `translateText`
- Adjust `MAX_MESSAGE_LENGTH` in [`config.js`](config.js) if you expect longer messages
- Update `LANG_RULE` / `LANG_LABEL` / `LANG_NATIVE` for different target languages

## Metrics analysis

Raw per-call events are appended to `data/metrics-YYYY-MM-DD.jsonl`:

```jsonl
{"t":1779565200000,"src":"kr","tgt":"en","ms":823,"hit":0}
{"t":1779565200500,"src":"kr","tgt":"jp","hit":1}
{"t":1779565201200,"src":"kr","tgt":"cn","ms":1102,"hit":0,"err":1}
```

Analyze offline with `jq`, `grep`, or any tool of choice:

```bash
# Average API latency for kr→jp
cat data/*.jsonl | jq -s '[.[] | select(.src=="kr" and .tgt=="jp" and .hit==0) | .ms] | add/length'

# Cache hit rate
cat data/*.jsonl | jq -s '[.[] | .hit] | (add / length * 100)'
```

## License

MIT — see [LICENSE](LICENSE).

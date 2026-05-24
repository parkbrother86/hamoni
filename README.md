# Hamoni

Real-time Discord chat translation relay between Korean / English / Japanese / Chinese channels. LLM-powered, latency-optimized, MMORPG-tuned.

---

## Features

- Automatic translation and relay across 4 language channels (KR / EN / JP / CN)
- Parallel API calls + LRU cache for low latency
- Message edit / delete sync, reply context preservation, attachment forwarding
- Mention, custom emoji, and Discord markdown preservation
- Per-user rate limiting
- `/stats` slash command (p50 / p95 / p99 latency, cache hit rate, per-pair breakdown)
- Persistent metrics log (JSONL, daily rotation)

---

# 1. Discord Bot Setup

## 1.1 Create the bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. **New Application** → enter a name (e.g. `Hamoni`) → Create
3. Left menu → **Bot** → **Reset Token** → **copy the token and store it somewhere safe** (shown only once)
4. On the same **Bot** page, scroll to **Privileged Gateway Intents**:
   - ✅ **MESSAGE CONTENT INTENT** (required)
   - The other intents can stay off

## 1.2 Invite the bot to your server

1. Left menu → **OAuth2** → **URL Generator**
2. **SCOPES**: ✅ `bot` ✅ `applications.commands`
3. **BOT PERMISSIONS**:
   - ✅ View Channels
   - ✅ Send Messages
   - ✅ Embed Links
   - ✅ Read Message History
   - ✅ Manage Webhooks
   - ✅ Use Application Commands
4. Open the generated URL, pick the server, confirm, and authorize.

## 1.3 Create channels and copy their IDs

1. In Discord, create 4 channels — one per language (e.g. `#chat-kr`, `#chat-en`, `#chat-jp`, `#chat-cn`).
2. Enable **User Settings → Advanced → Developer Mode**.
3. Right-click each channel → **Copy Channel ID** → save the 4 IDs (used in step 2.5).

---

# 2. Linux Server Installation

Tested on Ubuntu 22.04 / 24.04. Other distros: swap the package manager.

## 2.1 Update the OS and install Node.js

```bash
# Update the OS
sudo apt update && sudo apt upgrade -y

# Install Node.js 20 LTS (official NodeSource script)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version   # v20.x.x
npm --version
```

## 2.2 Install pm2

```bash
sudo npm install -g pm2
pm2 --version
```

## 2.3 Clone and install Hamoni

```bash
git clone https://github.com/parkbrother86/hamoni.git
cd hamoni
npm install
```

## 2.4 Configure environment variables

Create `.env`:

```bash
nano .env
```

Contents:

```env
DISCORD_TOKEN=the_bot_token_from_step_1.1
DEEPSEEK_API_KEY=your_deepseek_api_key
```

Get a DeepSeek API key at https://platform.deepseek.com .

## 2.5 Configure channel IDs

Edit `config.js`:

```bash
nano config.js
```

Replace the IDs in `CHANNELS` with the ones you copied in step 1.3:

```js
const CHANNELS = {
  kr: 'YOUR_KR_CHANNEL_ID',
  en: 'YOUR_EN_CHANNEL_ID',
  jp: 'YOUR_JP_CHANNEL_ID',
  cn: 'YOUR_CN_CHANNEL_ID',
};
```

## 2.6 Run with pm2

```bash
# Start
pm2 start index.js --name hamoni

# Check logs to confirm startup
pm2 logs hamoni

# You should see:
# Logged in as <BotName>#XXXX
# kr: #chat-kr <channelId>
# en: #chat-en <channelId>
# jp: #chat-jp <channelId>
# cn: #chat-cn <channelId>
# Slash commands registered on guild ...: /stats
```

## 2.7 Auto-start on boot

```bash
pm2 save
pm2 startup
# Then run the sudo command printed by `pm2 startup` to register the systemd unit
```

## Updating the code later

```bash
cd hamoni
git pull
npm install     # dependencies may have changed
pm2 restart hamoni
pm2 logs hamoni --lines 50
```

---

# 3. Using the Bot

## 3.1 Automatic behavior (no configuration needed)

Once the bot is running, any message posted in one of the 4 configured channels is automatically translated and relayed to the other 3. The webhook impersonates the original user's name and avatar so messages look like they were posted by that user.

```
Source (#chat-kr):  alice: 이번 주말 레이드 가능?
                ↓ auto translation
#chat-en:  [KR] alice: Can you join the raid this weekend? [⤴]
#chat-jp:  [KR] alice: 今週末のレイド参加可能? [⤴]
#chat-cn:  [KR] alice: 这周末能参加团本吗? [⤴]
```

The `[⤴]` at the end of each message is a clickable jump link back to the original.

## 3.2 What's handled automatically

| Behavior | Description |
|---|---|
| **Translation cache** | Repeated phrases (`ㅋㅋ`, `GG`, `AFK`, etc.) return instantly without an API call |
| **API skip** | Emoji-only / URL-only / number-only messages are relayed verbatim, no API call |
| **Same-language detection** | If a Korean channel message is written in English, the EN channel gets it as-is (no API call) |
| **Mention preservation** | `<@userId>` is rendered as `@displayname` (no ping); clicking it opens the real user profile |
| **Custom emoji** | `<:emoji:id>` renders correctly across all 4 channels (same guild only) |
| **Markdown** | `**bold**`, `||spoiler||`, ```` ```code blocks``` ```` etc. are preserved verbatim |
| **Attachments** | Images, files, and videos are forwarded automatically (also works for attachment-only messages) |
| **Long messages** | Over 300 chars: the original is relayed with a "message too long to translate" notice instead of being silently dropped |
| **Edit sync** | When the source is edited, all relayed copies are re-translated and updated |
| **Delete sync** | When the source is deleted, all relayed copies are deleted too |
| **Replies** | When you use Discord's reply feature, target channels get a `> quoted snippet` prefix for context |
| **Rate limit** | If a single user has 5+ messages in flight, additional messages are dropped to prevent flooding |

## 3.3 Slash commands

### `/stats`

Displays bot operational statistics, visible only to you (ephemeral):

```
Hamoni Bot Stats

Current session
  uptime 2d 14h 32m · rate limit drops 0
  edits 5 · deletes 2

Last 1 hour
  calls 234 · hit rate 38.1% · errors 1
  p50 680ms · p95 1.42s · p99 2.10s · avg 752ms

Last 24 hours
  calls 5891 · hit rate 41.3% · errors 8
  p50 720ms · p95 1.51s · p99 2.34s · avg 810ms

Per-pair p95 (24h, slowest first)
  kr→jp p95 1.62s (n=1430)
  kr→en p95 1.45s (n=1622)
  kr→cn p95 1.22s (n=1411)
  ...
```

- `p50 / p95 / p99`: latency percentiles. p95 = 1.5s means "95% of responses arrive within 1.5 seconds"
- `hit rate`: cache hit ratio. Higher = faster overall
- `errors`: failed API calls
- If the slash command doesn't show up: wait 1 minute after a bot restart, and verify the bot has `Use Application Commands` permission

## 3.4 Data layout

The bot writes daily metrics logs to the `data/` directory:

```
data/
├── metrics-2026-05-23.jsonl
├── metrics-2026-05-24.jsonl
└── ...
```

Each line is one API call or cache hit event:

```jsonl
{"t":1779565200000,"src":"kr","tgt":"en","ms":823,"hit":0}
{"t":1779565200500,"src":"kr","tgt":"jp","hit":1}
{"t":1779565201200,"src":"kr","tgt":"cn","ms":1102,"hit":0,"err":1}
```

`/stats` only shows up to the last 24 hours, but the raw data is persisted on disk and can be analyzed offline:

```bash
# Average API latency
cat data/*.jsonl | jq -s '[.[] | select(.hit==0 and .ms) | .ms] | add/length'

# Filter by language pair
cat data/*.jsonl | jq -c 'select(.src=="kr" and .tgt=="jp")'

# Only errors
cat data/*.jsonl | jq -c 'select(.err==1)'
```

## 3.5 Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Bot doesn't receive messages | Verify **MESSAGE CONTENT INTENT** is enabled in the Developer Portal |
| Slash commands don't appear | Verify the bot has `Use Application Commands` permission; wait 1–2 minutes after restart |
| Translation never arrives | Check `pm2 logs hamoni` for errors. Verify `DEEPSEEK_API_KEY` and the `Manage Webhooks` permission |
| Emojis / mentions are mangled | Custom emojis only render inside the same guild. Cross-guild emojis fall back to text |
| Edit sync doesn't work for old messages | Messages sent before the bot started aren't in the in-memory store. This is expected |
| Metrics seem to reset after pm2 restart | The persistent data lives in `data/*.jsonl`. Only the "current session" block in `/stats` resets |

## 3.6 Using it for non-MMORPG chat

The translator system prompt in [`translator.js`](translator.js) is tuned for MMORPG chat (preserves gaming slang like GG / AFK / DPS, uses a casual tone). To adapt for another domain:

- Edit the `system` message inside `translateText`
- Adjust `MAX_MESSAGE_LENGTH` in [`config.js`](config.js) if you expect longer messages
- To add a new language, add new entries to `CHANNELS`, `LANG_LABEL`, `LANG_NATIVE`, `LANG_RULE`, and `SOURCE_LANG_FLAG`

---

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

## License

MIT — see [LICENSE](LICENSE).

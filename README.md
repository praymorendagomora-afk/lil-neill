# Lil Neill

WhatsApp bot built with Node.js and `@whiskeysockets/baileys`. Pairing-code login, group admin tools, Cobalt downloaders, AI commands, anti-delete, and auto status view.

## Requirements

- Node.js 20+
- A WhatsApp number that can receive the pairing code
- Optional: OpenAI-compatible API key for `.gemini` / `.gpt`

## Local setup

```bash
# Install dependencies
npm install

# Copy environment template and edit values
cp .env.example .env
```

Set at least:

```env
BOT_NUMBER=12025550123
OWNER_NUMBER=12025550123
PORT=3000
```

`BOT_NUMBER` must be digits only, including country code, with no `+` or spaces.

Start the bot. `index.js` loads `.env` automatically if the file exists.

```bash
npm start
```

On first run the bot prints an 8-digit pairing code. In WhatsApp:

1. Linked Devices
2. Link a Device
3. Link with phone number instead
4. Enter the pairing code

Session files are stored in `auth_info/`. Keep that folder private.

Health check: `http://localhost:3000/health`

## Commands

| Command | Description |
|---|---|
| `.menu` `.help` `.alive` | Boxed status menu with uptime and ping |
| `.play` `.song` | Audio download via Cobalt |
| `.video` | Video download via Cobalt |
| `.tiktok` | TikTok download via Cobalt |
| `.gemini` `.gpt` | AI Q&A |
| `.kick` `.ban` `.promote` `.demote` | Group member controls |
| `.mute` `.unmute` | Group announcement lock |
| `.tagall` `.hidetag` | Mentions |
| `.antilink on/off` | Delete links and remove sender |
| `.restart` | Owner restart |

## Koyeb deployment

1. Push this repo to GitHub/GitLab.
2. In Koyeb: Create App -> GitHub -> select the repo.
3. Builder: **Buildpack** or **Dockerfile** (none required; Node buildpack is enough).
4. Run command: `npm start`
5. Instance port: `3000` (or the value of `PORT`)
6. Environment variables:

```text
BOT_NUMBER=12025550123
OWNER_NUMBER=12025550123
PORT=3000
USER_LLM_API_KEY=your-api-key-here
USER_LLM_BASE_URL=https://api.groq.com/openai/v1
USER_LLM_MODEL=llama-3.1-8b-instant
COBALT_API_URL=https://api.cobalt.tools
```

7. Deploy, open Runtime Logs, copy the pairing code, and link the device.
8. Persist `auth_info` with a volume if you do not want to pair again after every restart.

Render/VPS is the same: set env vars, run `npm start`, keep `auth_info` on disk.

## Notes

- Do not commit `.env` or `auth_info/`.
- Cloud hosts often block YouTube extraction; Cobalt is used as the download backend.
- AI commands stay disabled until `USER_LLM_API_KEY` is set.

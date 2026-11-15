# FreeAgent

A desktop AI agent in the style of Claude Desktop that does its work with the free AI you already have:

- **API keys:** OpenRouter and Google Gemini (AI Studio), plus any OpenAI-compatible endpoint you add as a custom API.
- **Free web plans:** Grok, ChatGPT, Gemini, Claude, DeepSeek, Pi, Kimi and Z.ai, driven through a real browser that you sign in to once.
- **Local coding agents:** OpenCode and Kiro CLI.

The left sidebar has **New chat**, **Automations**, **Projects** and **Customize**, plus your recent chats.

FreeAgent also runs a local server, so other tools can use your free providers:

- **Claude Code** can point at its Anthropic-compatible endpoint.
- **Claude Desktop** loads it as an MCP server.
- **Cursor, Continue, Aider and OpenCode** can use its OpenAI-compatible endpoint.

## What it does

| Area | What you get |
| --- | --- |
| Chat | Streaming replies with Markdown and code. Pick **Auto**, Auto · Code / Fast / Long context / Vision / Reasoning, a specific provider, or a specific model. |
| Modes | **Chat** answers only. **Agent** can call tools: read, write and list files, run shell commands and code, search and fetch the web, drive a browser, hand a task to OpenCode or Kiro, and use MCP tools. **Council** asks several providers and merges their answers. |
| Routing | Providers are tried in your order. On a rate limit, quota error, timeout or login problem, FreeAgent moves to the next provider and puts the failing one on a short cooldown. Daily request limits are tracked per provider. |
| Approvals | In Agent mode, writing files and running commands wait for **Allow** or **Deny**, unless you turn on auto-approve. |
| Projects | Shared instructions, text files used as context, and a working folder for the agent and coding apps. |
| Automations | Saved prompts that run on a cron schedule or on demand, with a stored run history. |
| Customize | Provider keys (encrypted on disk), browser sign-ins, CSS selector overrides for the websites, provider order, MCP servers, Claude Desktop linking, gateway URLs, theme and agent settings. |

## Run it locally

You need **Node.js 22.13 or newer** (24 recommended) and **pnpm 10**.

```bash
pnpm install          # also downloads the Electron binary
pnpm dev              # builds the server, then opens the desktop app
```

The desktop app starts the server in the background and connects to it. Open **Customize → Providers** to set things up. The quickest start is a free OpenRouter or Gemini key.

Website providers need Playwright's Chromium once:

```bash
pnpm browsers
```

Other commands:

```bash
pnpm test             # vitest: router fallback, agent loop, gateway translation, parsers
pnpm typecheck        # all packages
pnpm build            # server bundle + desktop app (output in apps/desktop/out)
pnpm --filter @freeagent/desktop build:linux   # or build:mac / build:win for an installer
```

### Headless server (no desktop window)

```bash
pnpm --filter @freeagent/server build
pnpm server           # http://127.0.0.1:47821
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `FREEAGENT_PORT` | `47821` | Server port |
| `FREEAGENT_HOST` | `127.0.0.1` | Bind address. Keep it on loopback unless you know why you need otherwise. |
| `FREEAGENT_DATA_DIR` | `~/.freeagent` | Database, token, keys and browser profiles |
| `FREEAGENT_TOKEN` | generated into `<dataDir>/token` | Bearer token for every API call |
| `FREEAGENT_SECRET_KEY` | generated into `<dataDir>/secret.key` | 32-byte key, base64-encoded, that encrypts stored API keys |

If the desktop app finds a headless server already running on the same data folder, it reuses that server.

## Setting up providers

| Provider | How |
| --- | --- |
| OpenRouter | Create a key at [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys). It defaults to the `openrouter/free` router, which picks a free model. You can pin a `:free` model in the provider settings. |
| Gemini API | Create a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). The default model is `gemini-2.5-flash`. |
| Custom API | Click **Add API** under **Customize → Providers**. Enter a name and the base URL of any OpenAI-compatible Chat Completions endpoint. The API key and model are optional; without a key, requests go out without an `Authorization` header. |
| Grok, ChatGPT, Gemini (web), Claude (web), DeepSeek, Pi, Kimi, Z.ai | Run `pnpm browsers` once. Then click **Sign in**, log in in the window that opens, close it, and click **Check login**. ChatGPT can also work without an account once you have connected it; the other sites need a sign-in. Each site keeps its own browser profile in `<dataDir>/browser-profiles/`. These are **experimental**: sites change their markup and add bot checks. If replies stop arriving, edit the selectors under **Selectors**, or turn on **Show browser windows** to solve a captcha. Tool calls are emulated through text, so prefer API providers for Agent mode. To use a specific model on a site, type its name in **Model name** (for example `Argon` on Gemini, `Expert` on Grok, `Sonnet` or `Opus` on Claude). Before each chat FreeAgent opens the site's model menu and clicks the matching entry; if nothing matches, the error lists what the menu offers. Leave it empty to keep the site's current model. Pi has no model menu. |
| OpenCode | Install it ([opencode.ai](https://opencode.ai/docs)) and run `opencode auth login` once. FreeAgent starts `opencode serve` and sends tasks to it in the project folder. |
| Kiro | Install `kiro-cli`, then run `kiro-cli login` or paste a `KIRO_API_KEY`. Tasks run with `kiro-cli chat --no-interactive`. |
| Claude Desktop | Claude Desktop connects to FreeAgent through MCP: see below. This is the app. **Claude (web)** in the website row above is your claude.ai browser account. |

App providers aren't used for ordinary Auto chat. Use them by picking them directly, or let the agent call `delegate_to_app`.

## Using FreeAgent from other tools

**Customize → Integrations** shows your gateway URL, API key and ready-to-copy commands.

**Claude Code** with free models:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:47821 ANTHROPIC_AUTH_TOKEN=<your token> claude
```

Claude model names are mapped onto the router. Sonnet and Opus go to Auto · Code, and Haiku goes to Auto · Fast. Tool use is passed through.

**OpenAI-compatible clients** use the base URL `http://127.0.0.1:47821/v1` and your token as the API key. The `model` can be:

- `auto`, `auto-code`, `auto-fast` or another auto target
- a provider id such as `openrouter`, `gemini-api`, `web-grok` or `web-deepseek`
- a provider and model, such as `openrouter::qwen/qwen3-coder:free`

`GET /v1/models` lists them all.

**Claude Desktop:** click **Link Claude Desktop** in Integrations, then restart Claude Desktop. This adds a stdio MCP server entry to `claude_desktop_config.json`, and Claude gets these tools:

- `list_providers`
- `ask_provider` (ask any free model or website)
- `run_automation`
- `search_projects`
- `delegate_to_app` (hand a coding task to OpenCode or Kiro)

**Any MCP client** can use streamable HTTP at `http://127.0.0.1:47821/mcp` with `Authorization: Bearer <token>`.

## Telegram bot

`apps/telegram` is a small bot that chats with FreeAgent from Telegram. Each Telegram conversation is a normal FreeAgent chat in **chat mode**, so it also appears in the desktop app. The bot runs as its own process, uses long polling (no public URL needed) and talks to the local server.

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Start FreeAgent (the desktop app, or `pnpm server`).
3. Run the bot:

```bash
TELEGRAM_BOT_TOKEN=<bot token> TELEGRAM_ALLOWED_IDS=<your Telegram user id> pnpm telegram
```

If `TELEGRAM_ALLOWED_IDS` is empty, nobody can chat with the bot. Every sender gets one reply that includes their user id, so you can message the bot once, read your id from the reply and restart with it set.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | required | Token from BotFather |
| `TELEGRAM_ALLOWED_IDS` | empty (nobody allowed) | Comma-separated Telegram user ids |
| `FREEAGENT_URL` | `http://127.0.0.1:47821` | Server URL |
| `FREEAGENT_TOKEN` | `<dataDir>/token` | Server bearer token |
| `FREEAGENT_DATA_DIR` | `~/.freeagent` | Used to find the token and the link file |
| `TELEGRAM_STATE_FILE` | `<dataDir>/telegram-links.json` | Telegram chat to FreeAgent chat links |

Commands: `/start` shows help, `/new` starts a new conversation, `/stop` cancels the current reply, `/target` shows the current target with buttons for Auto and every ready provider, and `/target <id>` sets it directly (`auto`, `auto-code`, `auto-fast`, a provider id). Only private chats and text messages are supported.

## Where data lives

Everything is stored in `~/.freeagent`, or in `FREEAGENT_DATA_DIR` if you set it:

- `freeagent.db` holds the SQLite database: chats, projects, automations, run history, provider settings and usage.
- `secret.key` or `secret.key.enc` is the encryption key for stored API keys. The desktop app protects it with the OS keychain.
- `token` is the local API token.
- `browser-profiles/` holds the signed-in browser sessions for the website providers.
- `web-sites/` holds your selector overrides.
- `workspaces/` holds the default working folders for chats and projects that don't have their own.

## Project layout

```
apps/desktop     Electron + React (electron-vite, Tailwind, shadcn/ui). Starts the server and renders the UI.
apps/server      Hono server: REST + SSE API, scheduler, OpenAI/Anthropic gateway, MCP server and stdio bridge.
apps/telegram    Telegram bot that chats with the local server (grammY, long polling).
packages/core    Providers, router, agent loop and tools, SQLite store (node:sqlite), encrypted secrets.
```

## Notes and limits

- Free tiers change often. The OpenRouter default uses its free router (`openrouter/free`), so you don't depend on one model name.
- Website automation may break the terms of service of some sites, and it can break whenever a site changes. Use it with your own accounts, and expect to adjust selectors.
- Shell and code tools run on your machine with your user's permissions. They're confined to the project folder only for file paths. Keep approvals on unless you trust the task.

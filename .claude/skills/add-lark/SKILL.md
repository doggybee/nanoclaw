---
name: add-lark
description: Add Lark (Larksuite) as a channel. Can replace WhatsApp entirely or run alongside it. Uses WebSocket long connection (no public URL needed).
---

# Add Lark Channel

This skill adds Lark (Larksuite international) support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `lark` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

1. **Mode**: Replace WhatsApp or add alongside it?
   - Replace → will set `LARK_ONLY=true`
   - Alongside → both channels active (default)

2. **Do they already have a Lark app configured?** If yes, collect the App ID and App Secret now. If no, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

Or call `initSkillsSystem()` from `skills-engine/migrate.ts`.

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-lark
```

This deterministically:
- Adds `src/channels/lark.ts` (LarkChannel class implementing Channel interface)
- Adds `src/channels/lark.test.ts` (unit tests)
- Three-way merges Lark support into `src/index.ts` (multi-channel support, conditional channel creation)
- Three-way merges Lark config into `src/config.ts` (LARK_ONLY export)
- Three-way merges updated routing tests into `src/routing.test.ts`
- Installs the `@larksuiteoapi/node-sdk` npm dependency
- Updates `.env.example` with `LARK_APP_ID`, `LARK_APP_SECRET`, and `LARK_ONLY`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts
- `modify/src/routing.test.ts.intent.md` — what changed for routing tests

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new lark tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Lark App (if needed)

If the user doesn't have a Lark app, share [LARK_SETUP.md](LARK_SETUP.md) which has step-by-step instructions with troubleshooting and a credential reference table.

Quick summary of what's needed:
1. Create a custom app at [open.larksuite.com](https://open.larksuite.com)
2. Enable Bot capability
3. Add permissions: `im:message`, `im:message:send_as_bot`, `im:chat:readonly`, `contact:user.base:readonly`
4. Subscribe to event: `im.message.receive_v1`
5. Copy App ID (`cli_...`) and App Secret
6. Publish app version and get admin approval

Wait for the user to provide both credentials.

### Configure environment

Add to `.env`:

```bash
LARK_APP_ID=cli_your_app_id
LARK_APP_SECRET=your_app_secret
```

If they chose to replace WhatsApp:

```bash
LARK_ONLY=true
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> 1. Add the bot to a Lark group (open group settings → **Bots** → **Add Bot**)
> 2. Send a test message in the group — the bot will log the chat_id
> 3. Check the database for discovered chats:
>    ```bash
>    sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE jid LIKE 'lark:%'"
>    ```
>
> The JID format for NanoClaw is: `lark:oc_abc123def456`

Wait for the user to provide the chat ID.

### Register the group

Use the IPC register flow or register directly. The chat ID, name, and folder name are needed.

For a main channel (responds to all messages, uses the `main` folder):

```typescript
registerGroup("lark:<chat-id>", {
  name: "<group-name>",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

For additional channels (trigger-only):

```typescript
registerGroup("lark:<chat-id>", {
  name: "<group-name>",
  folder: "<folder-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in your registered Lark group:
> - For main channel: Any message works
> - For non-main: `@<assistant-name> hello` (using the configured trigger word)
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

1. Check `LARK_APP_ID` and `LARK_APP_SECRET` are set in `.env` AND synced to `data/env/env`
2. Check group is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'lark:%'"`
3. For non-main groups: message must include trigger pattern
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Bot connected but not receiving messages

1. Verify Bot capability is enabled in the Lark app settings
2. Verify the bot is subscribed to `im.message.receive_v1`
3. Verify the bot has been added to the group
4. Verify the app version has been published and approved
5. Verify the required permissions are granted

### WebSocket connection failing

1. Check network connectivity to open.larksuite.com
2. Verify App ID starts with `cli_`
3. Verify App Secret is correct (regenerate if needed)
4. Check logs: `tail -f logs/nanoclaw.log | grep -i lark`

### Using wrong console

If you're in China or using Feishu (飞书), you need the Feishu console at open.feishu.cn, not open.larksuite.com. This skill is configured for Lark international (`Domain.Lark`). To use Feishu instead, change `Lark.Domain.Lark` to `Lark.Domain.Feishu` in `src/channels/lark.ts`.

### Getting chat ID

If the chat ID is hard to find:
- Check the bot's startup logs for synced chat metadata
- Send any message in the group and check `logs/nanoclaw.log` for the `lark:oc_` JID
- Query the database: `sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE channel = 'lark'"`

## After Setup

The Lark channel supports:
- **Group chats** — Bot must be added to the group
- **Direct messages** — Users can DM the bot directly
- **Multi-channel** — Can run alongside WhatsApp (default) or replace it (`LARK_ONLY=true`)

## Known Limitations

- **Text only** — The bot only processes text messages. Images, files, rich cards, and other content types are not forwarded to the agent.
- **No typing indicator** — Lark Bot API does not expose a typing indicator endpoint. The `setTyping()` method is a no-op.
- **Message splitting is naive** — Long messages are split at a fixed 4000-character boundary, which may break mid-word or mid-sentence.
- **@mention format** — Lark uses `@_user_N` placeholders in message text. The bot translates bot mentions to trigger format, but other user mentions remain as placeholders.
- **WebSocket reconnection** — The Lark SDK handles WebSocket reconnection internally. If the connection drops, messages received during the outage will be queued and sent when reconnected.

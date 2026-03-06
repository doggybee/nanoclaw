---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, configure Lark channel, register their main group, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run setup steps automatically. Only pause when user action is required (providing credentials, configuration choices). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. creating a Lark app, pasting a token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 1. Bootstrap (Node.js + Dependencies)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Use `AskUserQuestion: Would you like me to install Node.js 22?` If confirmed:
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - After installing Node, re-run `bash setup.sh`
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules` and `package-lock.json`, re-run `bash setup.sh`. If native module build fails, install build tools (`build-essential` on Linux, `xcode-select --install` on macOS), then retry.
- If NATIVE_OK=false → better-sqlite3 failed to load. Install build tools and re-run.
- Record PLATFORM for later steps.

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record DOCKER value for step 3

## 3. Container Runtime (Docker)

- DOCKER=running → continue to 3a
- DOCKER=installed_not_running → start Docker: `sudo systemctl start docker` (Linux) or `open -a Docker` (macOS). Wait 15s, re-check with `docker info`.
- DOCKER=not_found → Use `AskUserQuestion: Docker is required for running agents. Would you like me to install it?` If confirmed:
  - Linux: `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.
  - macOS: `brew install --cask docker`, then `open -a Docker` and wait for it to start.

### 3a. Build and test

Run `npx tsx setup/index.ts --step container -- --runtime docker` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Cache issue (stale layers): `docker builder prune -f`. Retry.
- Dockerfile syntax or missing files: diagnose from the log and fix, then retry.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 4. Claude Authentication

If HAS_ENV=true from step 2, read `.env` and check for `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. If present, confirm with user: keep or reconfigure?

AskUserQuestion: Claude subscription (Pro/Max) vs Anthropic API key?

**Subscription:** Tell user to run `claude setup-token` in another terminal, copy the token, add `CLAUDE_CODE_OAUTH_TOKEN=<token>` to `.env`. Do NOT collect the token in chat.

**API key:** Tell user to add `ANTHROPIC_API_KEY=<key>` to `.env`.

## 5. Lark Channel Configuration

Check if Lark is already configured by looking for `LARK_APP_ID` in `.env`.

If not configured, guide the user through Lark app setup:

AskUserQuestion: Do you have a Lark/Feishu custom app (自建应用) already created? If not, I'll walk you through creating one.

### 5a. Create Lark App (if needed)

Guide the user:

1. Go to Lark Developer Console
   - International (Lark): https://open.larksuite.com
   - China (Feishu/飞书): https://open.feishu.cn
2. Create a custom app (自建应用)
3. Enable **Bot** capability (添加应用能力 → 机器人)

4. **Permissions (权限管理)** — add all of the following scopes:

   **Messaging (消息):**
   - `im:message` — Send and receive messages (发送和接收消息)
   - `im:message:send_as_bot` — Send messages as bot (以应用的身份发消息)
   - `im:message:readonly` — Read message content (获取与发送单聊、群组消息)
   - `im:message:send_multi_content` — Send rich-text/post messages (以应用身份发送富文本消息)
   - `im:message.p2p_msg:readonly` — Receive private messages (接收私聊消息)
   - `im:message.group_msg:readonly` — Receive group messages (接收群聊消息)

   **Chat (群组):**
   - `im:chat` — Access chat info (获取群组信息)
   - `im:chat:readonly` — Read chat list (获取用户或机器人所在的群列表)

   **Resources (资源):**
   - `im:resource` — Download images/files from messages (获取消息中的资源文件)

   **Contact (通讯录):**
   - `contact:user.base:readonly` — Read basic user info for @mentions (获取用户基本信息)

   **CardKit (卡片):**
   - `cardkit:card` — Create and manage streaming cards (创建和管理卡片)
   - `cardkit:card:update` — Update card content (更新卡片内容) — needed for streaming typewriter effect
   - `cardkit:card_element` — Update card elements (更新卡片组件) — needed for streaming element updates

5. **Event Subscriptions (事件订阅):**
   - Set **Request URL** to `https://<your-public-url>/lark/events`
   - Subscribe to event: `im.message.receive_v1` (接收消息)
   - Lark will send a verification challenge — the bot handles this automatically

6. **Card Request URL (卡片回调 URL):**
   - In the bot configuration, set **Card Request URL** to `https://<your-public-url>/lark/events/card`
   - This enables interactive card button/select callbacks
   - Subscribe to event: `card.action.trigger` (卡片回调)

7. **Publish** the app version and get admin approval (发布应用版本)

### 5b. Collect Credentials

AskUserQuestion: Please provide:
- App ID (应用ID, starts with `cli_...`)
- App Secret (应用密钥)

Then ask:
- Webhook port (default: 3000)
- Webhook path (default: /lark/events)

Write the values to `.env`:
```
LARK_APP_ID=cli_your_app_id
LARK_APP_SECRET=your_app_secret
LARK_WEBHOOK_PORT=3000
LARK_WEBHOOK_PATH=/lark/events
```

### 5c. Verify Connection

Run `npm run build` then start the process temporarily to verify Lark connects:
```bash
timeout 15 node dist/index.js 2>&1 | head -50
```

Look for "Connected to Lark via Webhook" in the output. If it fails, check App ID/Secret and retry.

## 6. Configure Trigger and Register Main Group

AskUserQuestion: What trigger word should the bot respond to? (e.g., "@Andy", "@助手")

Then have the user add the bot to a Lark group and send a test message. Check the DB for discovered chats:
```bash
sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE jid LIKE 'lark:%'"
```

Present the list to the user:
AskUserQuestion: Which Lark group should be the main group?

Register:
```bash
npx tsx setup/index.ts --step register -- --jid "lark:<chat_id>" --name "main" --trigger "@TriggerWord" --folder "main" --channel lark
```

For the main group, add `--no-trigger-required` if the user wants the bot to respond to all messages without being @mentioned.

## 7. Mount Allowlist

AskUserQuestion: Should the agent have access to any external directories? (e.g., project repos, data directories)

**No:** `npx tsx setup/index.ts --step mounts -- --empty`
**Yes:** Collect paths/permissions. `npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'`

## 8. Start Service

If service already running: stop it first.
- Linux: `sudo systemctl stop nanoclaw` or `systemctl --user stop nanoclaw`
- macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`

Run `npx tsx setup/index.ts --step service` and parse the status block.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- Linux: check `systemctl status nanoclaw` or `systemctl --user status nanoclaw`.
- macOS: check `launchctl list | grep nanoclaw`.
- Re-run the service step after fixing.

## 9. Verify

Run `npx tsx setup/index.ts --step verify` and parse the status block.

**If STATUS=failed, fix each:**
- SERVICE=stopped → `npm run build`, then restart: `sudo systemctl restart nanoclaw` (Linux) or `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS)
- SERVICE=not_found → re-run step 8
- CREDENTIALS=missing → re-run step 4
- REGISTERED_GROUPS=0 → re-run step 6

Tell user to test: send a message in their registered Lark group, mentioning the trigger word. Show: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 8), missing `.env` (step 4).

**Container agent fails ("Claude Code process exited with code 1"):** Ensure Docker is running — `sudo systemctl start docker` (Linux) or `open -a Docker` (macOS). Check container logs in `groups/main/logs/container-*.log`.

**No response to messages:** Check trigger pattern. Main channel doesn't need prefix if `--no-trigger-required` was set. Check DB: `npx tsx setup/index.ts --step verify`. Check `logs/nanoclaw.log`.

**Lark webhook not receiving events:** Ensure the server's port is accessible from Lark's servers. Check firewall rules. The webhook URL must be publicly reachable (or reachable from Lark/Feishu network if deployed on internal infrastructure with Feishu private deployment).

**Using wrong console:** If using Feishu (飞书), use open.feishu.cn, not open.larksuite.com. To switch the SDK domain, change `Lark.Domain.Lark` to `Lark.Domain.Feishu` in `src/channels/lark.ts`.

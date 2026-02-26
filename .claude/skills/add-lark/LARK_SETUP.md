# Lark App Setup for NanoClaw

Step-by-step guide to creating and configuring a Lark (Larksuite) custom app for use with NanoClaw.

## Prerequisites

- A Lark (Larksuite) workspace where you have admin permissions
- Your NanoClaw instance with the `/add-lark` skill applied

## Step 1: Create the Lark App

1. Go to [open.larksuite.com](https://open.larksuite.com) (Lark international developer console)
2. Click **Create Custom App**
3. Enter an app name (e.g., your `ASSISTANT_NAME` value, or any name you like)
4. Enter a description
5. Click **Create**

## Step 2: Enable Bot Capability

1. In the sidebar, click **Features** > **Bot**
2. Toggle **Enable Bot** to **On**
3. This allows the app to receive and send messages as a bot

## Step 3: Add Permissions (Scopes)

These permissions control what the bot is allowed to do.

1. In the sidebar, click **Permissions & Scopes**
2. Search and add each of these scopes:

| Scope | Why it's needed |
|-------|----------------|
| `im:message` | Receive messages in groups and chats |
| `im:message:send_as_bot` | Send messages as the bot |
| `im:chat:readonly` | List chats the bot is in (for metadata sync) |
| `contact:user.base:readonly` | Look up user display names |

## Step 4: Subscribe to Events

This tells Lark which events to forward to your bot.

1. In the sidebar, click **Event Subscriptions**
2. Add the following event:

| Event | What it does |
|-------|-------------|
| `im.message.receive_v1` | Receive messages sent to the bot or in groups the bot is in |

3. For the subscription method, the bot uses **WebSocket mode** (long connection), so no callback URL is needed

## Step 5: Get App Credentials

1. In the sidebar, click **Credentials & Basic Info**
2. **Copy the App ID** — it starts with `cli_`
3. **Copy the App Secret**
4. Save both somewhere safe; you'll need them for NanoClaw configuration

## Step 6: Publish the App

1. In the sidebar, click **App Release** > **Version Management**
2. Click **Create Version**
3. Set a version number (e.g., `1.0.0`)
4. Set availability scope (which users/groups can use the app)
5. Click **Submit for Review** (for organization apps, an admin must approve)

After approval, the app will be available in your Lark workspace.

## Step 7: Configure NanoClaw

Add the credentials to your `.env` file:

```
LARK_APP_ID=cli_your_app_id_here
LARK_APP_SECRET=your_app_secret_here
```

If you want Lark to replace WhatsApp entirely (no WhatsApp channel), also add:

```
LARK_ONLY=true
```

Then sync the environment to the container:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Step 8: Add the Bot to Groups

The bot only receives messages from groups it has been added to.

1. Open a Lark group chat
2. Click the group name at the top to open group settings
3. Go to **Bots** > **Add Bot**
4. Search for your bot name and add it

Repeat for each group you want the bot in.

## Step 9: Get Chat IDs for Registration

You need the Lark chat ID to register it with NanoClaw.

**Option A — From bot logs:**
When the bot receives a message, it logs the chat_id. Check `logs/nanoclaw.log` for entries containing `lark:oc_`.

**Option B — From the API:**
The bot syncs chat metadata on startup. Check the database:
```bash
sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE jid LIKE 'lark:%'"
```

The NanoClaw JID format is `lark:` followed by the chat ID, e.g., `lark:oc_abc123def456`.

## Credential Reference

| Credential | Prefix | Where to find it |
|------------|--------|-----------------|
| App ID | `cli_` | **Credentials & Basic Info** |
| App Secret | (none) | **Credentials & Basic Info** |

## Troubleshooting

**Bot not receiving messages:**
- Verify Bot capability is enabled (Step 2)
- Verify the `im.message.receive_v1` event is subscribed (Step 4)
- Verify the bot has been added to the group (Step 8)
- Verify the app version has been published and approved (Step 6)

**"permission denied" errors:**
- Go back to **Permissions & Scopes** and add the missing scope
- After adding scopes, you must publish a new app version for changes to take effect

**Bot can't send messages:**
- Verify the `im:message:send_as_bot` scope is added
- Verify the bot has been added to the target group

**Credentials not working:**
- App ID starts with `cli_` — if yours doesn't, you may have copied the wrong value
- Make sure you're using the international Lark console (open.larksuite.com), not the Feishu console (open.feishu.cn)
- If you regenerated a secret, update `.env` and re-sync: `cp .env data/env/env`

**WebSocket connection failing:**
- Check your network can reach Lark's servers (open.larksuite.com)
- Verify App ID and App Secret are correct
- Check logs for specific error messages: `tail -f logs/nanoclaw.log`

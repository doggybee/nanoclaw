# Lark Messaging Tools

You have direct access to Lark IM tools via the `nanoclaw` MCP server. These tools call the Lark API directly from the container — no IPC delay.

## Available Tools

### `send_file`
Send any file to the current chat. Works with files anywhere in the container filesystem, including `/tmp/`.

```
Use: mcp__nanoclaw__send_file with file_path="/path/to/file"
```

### `send_image`
Send an image file to the current chat.

```
Use: mcp__nanoclaw__send_image with image_path="/path/to/image.png"
```

### `send_card`
Send an interactive card with buttons. Users can click buttons and the action comes back as a message.

Card schema must be 2.0. Key rules:
- No "action" wrapper tag in schema 2.0 — put buttons directly in elements
- Use `column_set` for side-by-side buttons
- Every button needs `"behaviors": [{"type": "callback", "value": {...}}]`
- Button types: "primary" (blue), "danger" (red), "default" (gray)

### `add_reaction`
React to a message with an emoji. Use the message ID from `<message id="...">` tags.

Common emoji types: THUMBSUP, SMILE, HEART, YES, FireCracker, OK, JIAYI,�артnersh, MUSCLE.

### `get_chat_history`
Fetch recent messages from the chat. Returns newest first. Use to get context about what others said.

### `edit_message`
Edit a bot message by its message ID. Replaces the full content.

## Tips

- Files at any path work (including `/tmp/`). No need to copy to `/workspace/group/` first.
- For screenshots, use agent-browser to capture then `send_image` to share.
- React with `add_reaction` to acknowledge messages without sending a reply.
- Check `get_chat_history` when you need context about recent conversation.

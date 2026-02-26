# Intent: src/index.ts modifications

## What changed
Added Lark channel support alongside the existing WhatsApp channel, following the same multi-channel architecture pattern.

## Key sections

### Imports (top of file)
- Added: `LarkChannel` from `./channels/lark.js`
- Added: `LARK_ONLY` from `./config.js`
- Added: `readEnvFile` from `./env.js`
- Existing: `findChannel` from `./router.js` and `Channel` type from `./types.js` are already present

### Module-level state
- Kept: `let whatsapp: WhatsAppChannel` — still needed for `syncGroupMetadata` reference
- Added: `let lark: LarkChannel | undefined` — direct reference for `syncChatMetadata`
- Kept: `const channels: Channel[] = []` — array of all active channels

### processGroupMessages()
- Uses `findChannel(channels, chatJid)` lookup (already exists in base)
- Uses `channel.setTyping?.()` and `channel.sendMessage()` (already exists in base)

### startMessageLoop()
- Uses `findChannel(channels, chatJid)` per group (already exists in base)
- Uses `channel.setTyping?.()` for typing indicators (already exists in base)

### main()
- Added: Reads Lark credentials via `readEnvFile()` to check if Lark is configured
- Added: conditional WhatsApp creation (`if (!LARK_ONLY)`)
- Added: conditional Lark creation (`if (hasLarkCredentials)`)
- Changed: IPC `syncGroupMetadata` syncs both WhatsApp and Lark metadata

### Shutdown handler
- Uses `for (const ch of channels) await ch.disconnect()` — disconnects all active channels

## Invariants
- All existing message processing logic (triggers, cursors, idle timers) is preserved
- The `runAgent` function is completely unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- Container runtime check is unchanged (ensureContainerSystemRunning)

## Design decisions

### Double readEnvFile for Lark credentials
`main()` in index.ts reads `LARK_APP_ID`/`LARK_APP_SECRET` via `readEnvFile()` to check
whether Lark is configured (controls whether to instantiate LarkChannel). The LarkChannel
constructor reads them again independently. This is intentional — index.ts needs to decide
*whether* to create the channel, while LarkChannel needs the actual credential values. Keeping
both reads follows the security pattern of not passing secrets through intermediate variables.

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
- The outgoing queue flush and reconnection logic (in each channel, not here)

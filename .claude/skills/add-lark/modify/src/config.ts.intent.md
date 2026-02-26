# Intent: src/config.ts modifications

## What changed
Added LARK_ONLY configuration export for Lark channel support.

## Key sections
- **readEnvFile call**: Must include `LARK_ONLY` in the keys array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.
- **LARK_ONLY**: Boolean flag from `process.env` or `envConfig`, when `true` disables WhatsApp channel creation
- **Note**: LARK_APP_ID and LARK_APP_SECRET are NOT read here. They are read directly by LarkChannel via `readEnvFile()` in `lark.ts` to keep secrets off the config module entirely (same pattern as SLACK_BOT_TOKEN in slack.ts).

## Invariants
- All existing config exports remain unchanged
- New Lark key is added to the `readEnvFile` call alongside existing keys
- New export is appended at the end of the file
- No existing behavior is modified — Lark config is additive only
- Both `process.env` and `envConfig` are checked (same pattern as `ASSISTANT_NAME`)

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction

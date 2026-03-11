# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to Lark (Feishu), routes messages to Claude Agent SDK running in Docker containers. Each group has isolated filesystem and memory. Supports per-user concurrent processing via SlotKey (`chatJid::senderId`).

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/lark.ts` | Lark channel: webhook, cards, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |


## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, Lark configuration, service startup |
| `/customize` | Adding integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Local Search (QMD)

Use `qmd` for codebase search to save tokens. Prefer it over multiple grep/read cycles.

```bash
qmd collection add . --name project   # Index codebase (one-time)
qmd query "how does container spawning work"  # Semantic search
qmd search "container-runner" -n 5    # Fast keyword search
```

**Rule of thumb:** If you'd need more than 3 grep attempts, use `qmd query` instead.

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Writing Style (避免 AI 腔)

写出来的东西要像人写的，不是模型生成的。

**禁用词和句式：**
- 禁止 AI 高频词：Additionally, crucial, delve, landscape（抽象）, pivotal, showcase, tapestry, testament, underscore, vibrant, foster, garner, intricate, enduring
- 禁止夸大意义："标志着...的关键转折"、"深远影响"、"具有里程碑意义"
- 禁止 -ing 填充："highlighting...", "underscoring...", "reflecting...", "contributing to..."
- 禁止假替代：用"是"就好，不要"serves as"、"stands as"、"represents"
- 禁止三连排比：不要强行凑三个并列项来显得全面
- 禁止否定式排比："不仅仅是X，更是Y"
- 禁止虚假归因："业内人士认为"、"专家指出"（没有具体来源就别说）
- 少用破折号（——），用逗号或句号代替

**应该做的：**
- 简单直接，能用短句说清楚就不用长句
- 句子长短交替，不要每句都一样长
- 给出具体细节，不要泛泛而谈
- 有观点就直说，不要两边都不得罪的废话
- 不确定就说不确定，不要用"可能在某种程度上或许会有一些影响"这种过度 hedge

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

# NanoClaw 架构与功能说明

## 概述

NanoClaw 是一个个人 AI 助手系统，将飞书（Lark）消息接入 Claude，在 Docker 容器中运行 Claude Agent SDK 处理每条消息。每个群组拥有独立的文件系统和记忆，支持多用户并发、定时任务、流式卡片回复、浏览器自动化和本地语义搜索。

核心设计原则：

- **容器隔离**：每次对话在独立 Docker 容器中执行，群组间文件系统完全隔离
- **凭证安全**：容器不接触真实 API 密钥，所有请求通过宿主机代理转发
- **多用户并发**：同一群组内不同用户的消息可以并行处理，互不阻塞
- **记忆持久化**：会话记录、群组配置、共享知识库跨对话持久保存

---

## 系统架构

```
飞书用户
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  宿主机 Node.js 进程                                      │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌────────┐ │
│  │ Lark     │  │ 消息循环  │  │ 并发队列   │  │ 任务   │ │
│  │ Channel  │→ │ (1s轮询) │→ │ (SlotKey) │→ │ 调度器 │ │
│  └──────────┘  └──────────┘  └───────────┘  └────────┘ │
│       │                            │                     │
│       │         ┌──────────────────┘                     │
│       │         ▼                                        │
│       │    ┌──────────┐     ┌──────────────┐            │
│       │    │ 容器管理  │     │ 凭证代理     │            │
│       │    │ (Docker) │     │ (HTTP:3001)  │            │
│       │    └──────────┘     └──────────────┘            │
│       │         │                   │                    │
└───────┼─────────┼───────────────────┼────────────────────┘
        │         │                   │
        │         ▼                   │
        │    ┌──────────────────┐     │
        │    │ Docker 容器       │     │
        │    │                  │     │
        │    │ Claude Agent SDK │─────┘ (API 请求经代理转发)
        │    │ + MCP 工具       │
        │    │ + agent-browser  │
        │    │ + QMD 搜索       │
        │    └──────────────────┘
        │         │
        │         │ IPC (文件系统)
        │         ▼
        │    宿主机处理 IPC 消息
        │    (发送消息、任务调度等)
        │         │
        └─────────┘ (回复发送到飞书)
```

---

## 消息生命周期

### 1. 接收

飞书通过 Webhook 推送事件到宿主机 HTTP 服务器（默认端口 3000）。LarkChannel 解析事件，提取消息内容、发送者、群组信息，写入 SQLite 数据库。

### 2. 消息循环

主循环每 1 秒轮询数据库，按群组和发送者分组：

```
新消息 → 按群组分组 → 按发送者分组 → 检查触发条件 → 加入并发队列
```

**触发条件**：
- 群聊：需要 @机器人 或匹配触发词（如 `@Andy`）
- 私聊：所有消息直接触发，无需 @

### 3. 并发调度

队列使用 `SlotKey = chatJid::senderId` 标识每个用户的独立处理槽位。两层并发限制同时生效：

| 限制 | 默认值 | 配置项 |
|------|--------|--------|
| 全局容器上限 | 3 | `MAX_CONCURRENT_CONTAINERS` |
| 每群组容器上限 | 2 | `MAX_CONTAINERS_PER_GROUP` |

超出限制时消息排队等待，空闲时自动消费。

### 4. 容器启动

为该 SlotKey 启动 Docker 容器，挂载对应群组的文件目录，通过 stdin 传入消息内容。容器内 Claude Agent SDK 处理消息，实时流式输出到飞书卡片。

### 5. 流式回复

容器内的 ReplySession 管理飞书卡片的流式更新：

1. **创建卡片**：发送一张「思考中...」的交互式卡片
2. **流式更新**：通过 CardKit API 每 100ms 推送内容更新（打字机效果）
3. **完成**：关闭流式模式，显示最终内容和耗时

如果 CardKit 连续失败 3 次，自动降级为 IM Patch 模式（整卡替换）。

### 6. 后续消息

如果用户在容器运行期间发送新消息，不会启动新容器，而是通过 IPC 文件系统把消息推送到正在运行的容器，实现连续对话。

### 7. 重试机制

容器执行失败时（无输出），回滚消息游标，按指数退避重试：5s → 10s → 20s → 40s → 80s，最多 5 次。超过后通知用户。

---

## 容器系统

### 容器镜像

基于 `node:22-slim`，预装：

| 工具 | 用途 |
|------|------|
| Claude Code | Claude Agent SDK CLI |
| agent-browser | 基于 Chromium 的浏览器自动化 |
| RTK | CLI token 优化代理（减少 60-90% token 消耗） |
| QMD | 本地语义搜索（BM25 + 向量 + LLM 重排） |
| Bun | QMD 的运行时依赖 |
| Chromium | 浏览器（agent-browser 使用） |
| git, curl, jq | 常用工具 |

容器以 `node` 用户（uid 1000）运行，非 root。

### 文件挂载

每个容器启动时根据群组配置挂载不同目录：

**所有容器共有**：
| 容器路径 | 说明 | 权限 |
|----------|------|------|
| `/workspace/group/` | 群组专属目录 | 读写 |
| `/workspace/ipc/` | IPC 通信目录（按 slot 隔离） | 读写 |
| `/workspace/global/` | 全局 CLAUDE.md 和说明 | 只读 |
| `/workspace/global/knowledge/` | 共享知识库 | 读写（覆盖上层只读） |
| `/home/node/.claude/` | 会话数据（session、settings） | 读写 |
| `/home/node/.cache/qmd/` | QMD 模型和索引缓存 | 读写 |

**主群组额外挂载**：
| 容器路径 | 说明 | 权限 |
|----------|------|------|
| `/workspace/project/` | 项目根目录 | 只读 |
| `/workspace/project/.env` | 映射到 /dev/null，屏蔽密钥 | — |

容器间文件系统完全隔离，群组 A 的容器无法访问群组 B 的文件。

### 权限处理

- **root 宿主机**：`chown` 挂载目录为 uid 1000（容器 node 用户）
- **非 root 宿主机**：`chmod 777` 挂载目录（容器 uid 不同，需要 world-writable）

### 资源限制

| 参数 | 默认值 | 配置项 |
|------|--------|--------|
| 内存 | 2GB | `CONTAINER_MEMORY` |
| CPU | 1 核 | `CONTAINER_CPUS` |
| 运行超时 | 30 分钟 | `CONTAINER_TIMEOUT` |
| 空闲超时 | 30 分钟 | `IDLE_TIMEOUT` |

### 预热池（Warm Pool）

为减少冷启动延迟（4-6 秒），系统预先启动容器并完成 SDK 初始化，收到消息时直接注入：

- 默认池大小：1 个容器（`WARM_POOL_SIZE`）
- 按最近活跃度排序，优先预热常用群组
- 连续失败 5 次后禁用该群组的预热

---

## 凭证代理

容器从不接触真实 API 密钥。所有 Anthropic API 请求走宿主机 HTTP 代理（默认端口 3001）：

```
容器 → HTTP 请求（占位符凭证）→ 宿主机代理 → 注入真实凭证 → api.anthropic.com
```

支持三种认证方式（按优先级）：

1. `.env` 中的 `ANTHROPIC_API_KEY`
2. `.env` 中的 `CLAUDE_CODE_OAUTH_TOKEN`
3. `~/.claude/.credentials.json`（Claude CLI 登录凭证，自动刷新）

OAuth token 过期前 5 分钟自动刷新，代理每 4 分钟重新加载凭证。

---

## 会话管理

### 会话持久化

每个 SlotKey（群组 + 用户）拥有独立的 Claude Agent SDK 会话。会话以 JSONL 格式存储在 `/home/node/.claude/` 目录。

### 会话轮换

满足以下任一条件时创建新会话：

| 条件 | 默认值 | 配置项 |
|------|--------|--------|
| 空闲超时 | 4 小时 | `SESSION_IDLE_TIMEOUT` |
| 文件大小超限 | 2 MB | `SESSION_MAX_BYTES` |
| 手动触发 | `/compact` 命令 | — |

### 对话归档

会话压缩（compact）前，自动将对话内容归档到 `/workspace/group/conversations/` 目录，格式为 Markdown，文件名包含日期和摘要。Agent 可以通过 QMD 搜索历史对话。

---

## 飞书功能

### 支持的入站消息类型

| 类型 | 说明 |
|------|------|
| `text` | 纯文本消息 |
| `post` | 富文本（粗体、斜体、删除线、行内代码、链接、@、图片、代码块、分割线） |
| `image` | 图片（自动下载到群组 `tmp/` 目录，agent 可直接读取） |
| `file` | 文件附件（自动下载，保留文件名） |
| `audio` | 语音消息（提取时长） |
| `video` / `media` | 视频/媒体消息 |
| `sticker` | 表情贴纸 |
| `interactive` | 交互式卡片（转为文本描述） |
| `location` | 位置分享（名称 + 经纬度） |
| `todo` | 飞书任务（摘要、内容、截止日期） |
| `share_chat` | 群组分享 |
| `share_user` | 联系人分享 |
| `merge_forward` | 合并转发（展开所有子消息，包含时间戳和发送者） |
| `system` | 系统消息（加退群、群名变更等） |
| `hongbao` | 红包 |
| `share_calendar_event` / `calendar` / `general_calendar` | 日历事件/邀请 |
| `video_chat` | 音视频会议邀请 |
| `vote` | 投票 |
| `folder` | 文件夹 |

### 流式卡片回复

Agent 的回复通过飞书交互式卡片（Schema 2.0）实时流式展示：

- **主模式 (CardKit)**：创建卡片后通过 CardKit API 按 100ms 间隔推送增量更新
- **降级模式 (IM Patch)**：CardKit 失败时整卡替换
- 卡片包含：思考过程折叠区、正文内容、状态和耗时页脚
- 支持 Markdown 渲染（标题、代码块、表格、列表、粗体、斜体等）

### 卡片交互

Agent 可以发送带按钮的交互式卡片，用户点击后触发回调：

- 按钮类型：primary（蓝色）、danger（红色）、default（灰色）
- 支持 `_owner` 字段控制操作权限（仅特定用户可点击）
- 回调返回 toast 提示

### Agent 可用的飞书工具

**消息工具**：

| 工具 | 说明 |
|------|------|
| `send_message` | 发送文本消息（仅定时任务可用） |
| `send_image` | 上传并发送图片（最大 30MB） |
| `send_file` | 上传并发送文件（最大 30MB，自动识别类型） |
| `send_card` | 发送交互式卡片（Schema 2.0，支持按钮和布局） |
| `edit_message` | 编辑已发送的消息 |
| `add_reaction` | 给消息添加表情回应 |
| `get_chat_history` | 获取群聊记录（本地 SQLite 查询，<1ms；Lark API 作为 fallback） |

**飞书文档工具**：

| 工具 | 说明 |
|------|------|
| `docx_create` | 创建云文档 |
| `docx_read` | 读取文档内容 |
| `docx_list_blocks` | 列出文档结构（块类型、ID、内容） |
| `docx_append` | 追加内容（文本、标题、列表、代码、待办、分割线） |

**飞书表格工具**：

| 工具 | 说明 |
|------|------|
| `sheets_create` | 创建电子表格 |
| `sheets_read` | 读取指定范围（如 `Sheet1!A1:D10`） |
| `sheets_write` | 写入指定范围 |
| `sheets_append` | 追加行 |

**飞书任务工具**：

| 工具 | 说明 |
|------|------|
| `lark_task_create` | 创建飞书任务（标题、描述、截止时间） |
| `lark_task_list` | 列出任务（可按完成状态过滤） |
| `lark_task_complete` | 完成任务 |
| `lark_task_update` | 更新任务字段 |
| `lark_task_delete` | 删除任务 |

**搜索工具**：

| 工具 | 说明 |
|------|------|
| `search_messages` | 跨聊天全文搜索（可按消息类型、发送者类型过滤） |

### 消息去重

基于消息 ID 的 TTL 缓存（10 分钟），防止 Webhook 重复推送导致重复处理。每 5 分钟自动清理过期条目。

### 已撤回消息保护

MessageGuard 机制检测已撤回/删除的消息（API 错误码 230011、231003），30 分钟 TTL 缓存避免重复请求。

### 群组元数据同步

Channel 连接后在后台分页拉取所有机器人所在群组的名称，批量写入数据库，30 秒超时。

---

## 自动注册

新用户（私聊或群聊）首次发消息时自动注册，无需手动配置：

- **群聊**：文件夹名 `g-{chatId后12位}`，需要 @触发
- **私聊**：文件夹名 `dm-{chatId后12位}`，所有消息直接触发

注册后自动创建群组目录和数据库记录。

---

## 定时任务

Agent 可以创建定时任务，在指定时间或周期执行：

### 调度类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `cron` | Cron 表达式 | `0 9 * * 1-5`（工作日 9 点） |
| `interval` | 固定间隔（毫秒） | `3600000`（每小时） |
| `once` | 一次性（ISO 时间戳） | `2026-03-10T09:00:00Z` |

### 执行流程

1. 调度器每 60 秒检查到期任务
2. 以 `__task__` 作为 senderId 加入并发队列
3. 启动容器执行任务 prompt
4. 任务容器 10 秒内无新输出即关闭（不等 30 分钟空闲）
5. 记录执行日志（时长、状态、错误）
6. 计算下次执行时间（interval 任务锚定上次计划时间，防止漂移）

### 任务管理

Agent 可通过 MCP 工具管理任务：`schedule_task`、`list_tasks`、`update_task`、`pause_task`、`resume_task`、`cancel_task`。

---

## 共享知识库

所有群组的 Agent 共享 `/workspace/global/knowledge/` 目录，使用 Obsidian 风格的 Markdown 持久化知识。

### 写入规则

Agent 在以下情况自动写入知识库：
- 用户纠正了 Agent 的错误认知
- 用户解释了内部流程、术语、业务规则
- 用户明确要求「记住」
- Agent 通过研究得到可复用的结论
- 用户分享了有价值的外部信息

### 格式规范

```markdown
---
tags: [domain/area, topic/subtopic]
source: 来源说明
updated: YYYY-MM-DD
---

# 标题

正文内容。用 [[related-note]] 链接相关笔记。
```

### 检索

容器启动时自动用 QMD 建立知识库索引。Agent 回答领域问题前先搜索知识库：

```bash
qmd query "相关问题" --collection kb     # 语义搜索
qmd search "关键词" --collection kb      # 关键词搜索
```

---

## Agent 能力总览

### SDK 内置工具

| 工具 | 说明 |
|------|------|
| `Bash` | 容器内执行命令 |
| `Read` / `Write` / `Edit` | 文件操作 |
| `Glob` / `Grep` | 文件搜索和内容搜索 |
| `WebSearch` / `WebFetch` | 网络搜索和网页抓取 |
| `Skill` | 调用技能（knowledge-base、agent-browser、qmd 等） |

### 容器内工具

| 工具 | 说明 |
|------|------|
| `agent-browser` | 浏览器自动化：打开页面、点击、填写表单、截图、提取数据、保存 PDF |
| `qmd` | 本地语义搜索：对工作区文件建立索引，支持 BM25、向量搜索和 LLM 重排 |
| `git` | 版本控制 |
| `curl` / `jq` | HTTP 请求和 JSON 处理 |

### NanoClaw MCP 工具

见上方「飞书功能 — Agent 可用的飞书工具」和「定时任务 — 任务管理」。

---

## IPC 通信

宿主机和容器通过文件系统进行通信，无网络 RPC：

```
data/ipc/{group}/slots/{slotId}/
├── input/       # 宿主机 → 容器（后续消息，JSON 文件）
├── messages/    # 容器 → 宿主机（发送消息请求）
├── tasks/       # 容器 → 宿主机（任务调度请求）
└── responses/   # 容器 → 宿主机（响应结果）
```

- **输入**：宿主机写入 JSON 文件到 `input/`，容器通过 `fs.watch` 监听
- **输出**：容器写入 JSON 文件到 `messages/` 或 `tasks/`，宿主机通过 `fs.watch` + 5 秒轮询监听
- **请求/响应**：容器写入带 `requestId` 的请求到 `messages/`，宿主机处理后将结果写到 `responses/{requestId}.json`，容器轮询等待（30ms 间隔，5 秒超时）
- **关闭信号**：宿主机写入 `input/_close` 文件通知容器退出

---

## 数据库

SQLite（WAL 模式），存储在 `store/messages.db`：

| 表 | 用途 |
|----|------|
| `chats` | 聊天元数据（JID、名称、类型） |
| `messages` | 消息记录（发送者、内容、时间戳、是否机器人消息） |
| `registered_groups` | 已注册群组（JID、文件夹、触发词、容器配置） |
| `sessions` | 会话映射（群组 + 用户 → session ID） |
| `scheduled_tasks` | 定时任务定义（调度类型、Cron 表达式、状态） |
| `task_run_logs` | 任务执行日志（时长、状态、错误） |
| `router_state` | 路由状态（消息游标、Agent 时间戳） |

脏标记优化：`taskVersion` 和 `chatVersion` 计数器，消费者在版本未变时跳过查询。

---

## 配置项

所有配置通过 `.env` 文件设置：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `ASSISTANT_NAME` | Andy | 机器人名称（触发词前缀） |
| `CLAUDE_MODEL` | — | Claude 模型 ID |
| `ANTHROPIC_API_KEY` | — | API 密钥（与 OAuth 二选一） |
| `CONTAINER_IMAGE` | nanoclaw-agent:latest | 容器镜像 |
| `CONTAINER_TIMEOUT` | 30 分钟 | 容器运行超时 |
| `IDLE_TIMEOUT` | 30 分钟 | 容器空闲超时 |
| `CONTAINER_MEMORY` | 2g | 容器内存限制 |
| `CONTAINER_CPUS` | 1 | 容器 CPU 限制 |
| `MAX_CONCURRENT_CONTAINERS` | 3 | 全局并发容器上限 |
| `MAX_CONTAINERS_PER_GROUP` | 2 | 每群组并发容器上限 |
| `WARM_POOL_SIZE` | 1 | 预热容器数量 |
| `SESSION_IDLE_TIMEOUT` | 4 小时 | 会话轮换空闲阈值 |
| `SESSION_MAX_BYTES` | 2 MB | 会话轮换大小阈值 |
| `CREDENTIAL_PROXY_PORT` | 3001 | 凭证代理端口 |
| `MODEL_ROUTER` | off | 模型路由（auto 启用智能选择） |
| `MODEL_FAST` | — | 快速模型（如 claude-haiku-4-5） |
| `LARK_APP_ID` | — | 飞书应用 ID |
| `LARK_APP_SECRET` | — | 飞书应用密钥 |
| `LARK_WEBHOOK_PORT` | 3000 | Webhook 服务端口 |
| `LARK_DOMAIN` | https://open.larksuite.com | 飞书 API 域名 |
| `TZ` | 系统时区 | 时区（影响 Cron 和日志） |

---

## 目录结构

```
NanoClaw/
├── src/                          # 宿主机源码
│   ├── index.ts                  # 主循环、消息处理、状态管理
│   ├── channels/lark/            # 飞书通道（Webhook、消息收发、卡片）
│   ├── container-runner.ts       # 容器生命周期管理
│   ├── group-queue.ts            # 并发调度队列
│   ├── credential-proxy.ts       # API 凭证代理
│   ├── task-scheduler.ts         # 定时任务调度
│   ├── db.ts                     # SQLite 数据库操作
│   ├── ipc.ts                    # IPC 消息处理
│   ├── config.ts                 # 配置项
│   └── types.ts                  # 类型定义
├── container/                    # 容器相关
│   ├── Dockerfile                # 容器镜像定义
│   ├── build.sh                  # 构建脚本
│   ├── agent-runner/             # 容器内 Agent 运行器
│   │   └── src/
│   │       ├── index.ts          # 入口：SDK 调用、流式输出
│   │       ├── ipc-mcp-stdio.ts  # MCP 工具（飞书、任务、群组管理）
│   │       └── lark/             # 容器内飞书能力
│   │           ├── card-builder.ts    # 卡片 JSON 构建
│   │           ├── cardkit.ts         # CardKit 流式 API
│   │           ├── reply-session.ts   # 流式回复会话
│   │           ├── workspace-tools.ts # 文档/表格/任务/搜索工具
│   │           └── markdown-style.ts  # Markdown 优化
│   ├── skills/                   # 容器内技能定义
│   │   ├── agent-browser/        # 浏览器自动化
│   │   ├── qmd/                  # 本地搜索
│   │   ├── knowledge-base/       # 知识库读写
│   │   └── lark-messaging/       # 飞书消息格式指南
│   └── rtk/                      # RTK token 优化
├── groups/                       # 群组数据
│   ├── global/                   # 全局共享
│   │   ├── CLAUDE.md             # 全局 Agent 指令
│   │   └── knowledge/            # 共享知识库
│   └── {group-folder}/           # 各群组独立目录
│       ├── CLAUDE.md             # 群组专属记忆
│       └── conversations/        # 对话归档
├── data/                         # 运行时数据
│   ├── sessions/                 # 会话文件（JSONL）
│   └── ipc/                      # IPC 通信目录
├── store/                        # 数据库
│   └── messages.db               # SQLite
└── docs/                         # 文档
```

---

## 常见问题（FAQ）

### 同一群组里多个用户同时提问，会造成写入冲突吗？

不会。系统通过 `SlotKey = chatJid::senderId` 做了多层隔离：

**完全隔离的部分：**
- **IPC 路径**：每个用户有独立的 IPC 目录 `data/ipc/{group}/slots/{senderId}/`，消息输入输出互不干扰
- **Session**：数据库用复合主键 `(group_folder, sender_id)`，每人独立的 Claude 会话
- **容器进程**：每个 slot 独立的 Docker 容器，独立的 stdin/stdout
- **队列状态**：`GroupQueue` 按 SlotKey 隔离，各自独立的 active/pending 状态

**SQLite 不会冲突：** 宿主机是单线程 Node.js，所有 DB 操作天然串行，加上 WAL 模式读写互不阻塞。

**唯一的共享可写区域是 group folder**（`groups/{name}/` → `/workspace/group`）。两个容器同时挂载同一个目录做读写。如果两个 Agent 同时改同一个文件（比如 CLAUDE.md），后写的会覆盖先写的。实际场景下风险很低：Agent 主要读 group folder 里的配置和记忆，写入不频繁；即使同时写，Claude Code 用的是 Edit tool（原子替换），不会出现内容交错。

### Agent 收到的 prompt 里包含什么？

Agent 不是只处理"触发的那条消息"，而是处理该用户自上次游标（`lastAgentTimestamp[slotKey]`）以来的所有未处理消息。具体流程（`processUserSlot`）：

1. 从 SQLite 拉取该 sender 自上次游标以来的所有消息
2. 如果 group 需要 trigger，过滤出包含触发词的消息
3. 用 `formatMessages()` 包成 XML 格式作为 prompt：

```xml
<messages>
<message id="msg-1" sender="张三" time="2024-01-01T12:00:00Z">@Andy 帮我查一下这个</message>
<message id="msg-2" sender="张三" time="2024-01-01T12:00:05Z">@Andy 补充一下，还要包含价格</message>
</messages>
```

4. 该 prompt 发给容器，容器里的 Claude Agent SDK 结合 session 上下文处理

如果容器还在运行时用户发了新消息，通过 `queue.sendMessage()` 直接以 IPC 文件推送到正在运行的容器，不用启动新容器。

### Agent 能看到其他用户的消息吗？群聊上下文怎么获取？

默认情况下，`processUserSlot` 只拉取该 sender 的消息（按 `senderId` 过滤）。如果 User A 和 User B 在群里讨论了 20 条，然后 User A @bot "你觉得呢"，Agent 只看到 User A 自己发的消息，看不到 User B 说了什么。

Agent 的上下文来源：

| 来源 | 内容 | 范围 |
|------|------|------|
| 当次 prompt | 该用户未处理的消息 | 仅该 sender |
| Session 历史 | Claude SDK 的 `.jsonl` 会话文件 | 该用户之前与 bot 的对话 |
| Group CLAUDE.md | 持久化的群组记忆 | 所有用户共享，但需要手动或 Agent 写入 |
| `get_chat_history` 工具 | 群聊近期消息 | 所有用户的消息（含 bot） |

**当 Agent 需要群聊上下文时**，可以主动调用 `get_chat_history` 工具获取最近的群聊消息。这个工具优先从宿主机 SQLite 读取（通过 IPC 请求/响应机制），延迟 <50ms；如果 IPC 超时则 fallback 到 Lark API。

这个设计是有意为之：不在 prompt 里硬塞所有群聊消息（会干扰 Agent、浪费 token），而是让 Agent 按需拉取。Agent 看到用户说"你觉得呢"、"刚才说的那个"之类缺少上下文的表述时，会自己判断需要调 `get_chat_history`。

### `get_chat_history` 的数据源和性能？

`get_chat_history` 有两条路径：

| 路径 | 数据源 | 延迟 | 触发条件 |
|------|--------|------|----------|
| IPC（主路径） | 宿主机 SQLite `messages` 表 | <1ms 查询 + ~30ms IPC 开销 | 默认 |
| Lark API（fallback） | 飞书服务器 | 200-500ms | IPC 5 秒超时后 |

IPC 路径的流程：
1. 容器 MCP 工具写 `{"type": "get_chat_history", "chatJid": "...", "count": 20, "requestId": "xxx"}` 到 `messages/` 目录
2. 宿主机 IPC watcher 检测到请求，调用 `getRecentMessages()` 从 SQLite 查询
3. 结果写到 `responses/{requestId}.json`
4. 容器 30ms 间隔轮询 `responses/` 目录，读取结果

SQLite 使用 WAL 模式，`messages` 表有 `idx_messages_chat_ts` 索引，查询 50 条消息是微秒级操作。多人并发读写不会阻塞。

---

## 部署要求

### 系统依赖

- Docker（用户需在 docker 组中）
- Node.js 22+
- `loginctl enable-linger`（非 root 部署时，保持 user service 常驻）

### 网络要求

**运行时**：
- `api.anthropic.com`（Claude API）
- `open.feishu.cn` 或 `open.larksuite.com`（飞书 API）

**构建时（首次）**：
- `registry.npmjs.org`（npm 包）
- `github.com`（RTK 二进制）
- `bun.sh`（Bun 安装）
- `registry-1.docker.io`（Docker 基础镜像）

### 认证方式

1. **API Key**：在 `.env` 设置 `ANTHROPIC_API_KEY`
2. **OAuth 登录**：在服务器运行 `claude` 命令完成 OAuth 授权，凭证自动保存到 `~/.claude/.credentials.json` 并自动刷新

# NanoClaw 开发日志

基于 [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) fork，定制为风控团队内部 Lark Agent 助手。

---

## 2026-02-26 — Lark 迁移

- **移除 WhatsApp，切换到 Lark（飞书）** — 重写消息通道，使用 Webhook 模式接收事件回调
- 添加 `add-lark` skill，包含完整的 Lark 应用创建和权限配置指引
- 移除不再需要的 WhatsApp 相关 channel skills
- 容器启动优化（减少冷启动时间）

## 2026-02-26 — Lark 消息能力

- **回复和 @mention** — 支持回复指定消息、@提及用户
- **Markdown Post 格式** — 富文本输出（加粗、斜体、代码、链接、标题）
- **CC 身份配置** — 定义 agent 的身份（风控技术助手）、沟通风格、领域知识

## 2026-02-27 — 本地搜索和性能

- **QMD 集成** — 在容器内安装语义搜索工具，支持对话历史和代码库检索
- **事件驱动消息循环** — 从轮询改为事件唤醒，减少无效 CPU 消耗
- 容器 QMD 缓存持久化挂载（索引和模型跨会话复用）

## 2026-02-28 — 交互增强

- **Emoji 表情回应** — 支持对消息添加表情反应
- 修复 ASSISTANT_NAME 配置不一致问题

## 2026-03-05 — Lark 富交互能力

- **图片/文件支持** — 接收和发送图片、文件，自动下载供 agent 处理
- **消息编辑** — 编辑已发送的消息（卡片和文本/Post 类型）
- **交互式卡片** — Card Schema 2.0 卡片，支持按钮和下拉选择的回调
- **聊天历史获取** — agent 可按需拉取群组近期消息（`im.v1.message.list`）
- **流式卡片** — 打字机效果的流式输出（CardKit streaming）

## 2026-03-05 — 响应延迟优化

- **即时文本回复** — 收到消息后立即发送文本，再异步创建流式卡片
- **模型路由** — 简单问题用快速模型，复杂问题用强模型
- **并行卡片创建** — Lark CardKit 调用并行化
- **IPC 轮询频率降低** — 减少容器和宿主机之间的通信开销

## 2026-03-06 — 流式卡片和预热容器

- **卡片加载态** — 流式输出时显示加载动画
- **Warm 容器池** — 预启动容器，首次响应从 ~3s 降到 <1s
- Warm 容器退避策略（启动失败时不反复重试）
- 卡片构建逻辑去重

## 2026-03-06 — 同群多用户并发

- **SlotKey 架构** — `chatJid::senderId` 实现同群内多用户独立处理
- **per-group 并发限制** — 全局 + per-group 双重上限，防止单群占满资源
- **Session 隔离** — 同群不同用户各自维护独立的 Claude 对话上下文
- **IPC 目录隔离** — 每个 slot 独立的 IPC 路径，多容器不冲突
- DB sessions 表迁移为 `(group_folder, sender_id)` 复合主键

## 2026-03-06 — 安全加固和性能优化

- **Warm 容器 Session 泄漏修复** — sessionId 从 IPC 激活消息传入，不再烤入预热容器
- **IPC 路径遍历防护** — slotId 和 requestId 校验，防止目录逃逸
- **环境变量缓存** — `.env` 解析一次后缓存，不再每次读盘
- **快照写入去重** — 内容相同时跳过磁盘写入
- **SQLite 事务批量化** — 聊天元数据同步改为单事务批量更新
- Warm pool 按最近活跃度选择候选群组
- 容器重试失败通知用户
- Slot 状态自动清理（防止内存泄漏）

## 2026-03-06 — MCP 工具增强

- **update_task** — 新增任务更新工具，支持修改已有定时任务
- **schedule_task 返回 task ID** — 方便后续引用和更新
- **register_group 描述修正** — 从 WhatsApp 改为通用 chat/group

## 2026-03-06 — Skills 清理和文档

- 删除 6 个不再使用的 skills（voice-transcription、convert-to-apple-container、x-integration、qodo-pr-resolver、get-qodo-rules、add-parallel）
- **/setup 重写** — 从 WhatsApp 改为 Lark，包含完整权限列表（含 CardKit 和 card.action.trigger）
- **add-lark skill 更新** — 权限文档补全
- CLAUDE.md 更新（移除废弃 skills）

## 2026-03-06 — 写作风格和工具集成

- **Anti-AI 写作规则** — 将 humanizer 核心规则写入 CLAUDE.md，agent 生成时自动遵循（零额外开销）
- **RTK (Rust Token Killer)** — 宿主机和容器都安装，通过 PreToolUse hook 自动压缩命令输出，节省 60-90% token
- **RTK 条件化集成** — 仅当 `container/rtk/` 存在时才注入 hook 配置
- `copyIfNewer()` 工具函数提取，消除文件同步逻辑重复
- `CONTAINER_HOME` 常量化，消除硬编码路径
- 离线安装文档（`docs/RTK_INSTALL.md`）

---

## 合并的上游修复

以下来自 qwibitai/nanoclaw 上游，经评估后合并：

- `claude-agent-sdk` 升级到 0.2.68
- 定时任务原子 claim（防止重复执行）
- 容器环境变量影子修复
- 命令注入防护（setup verify）
- CJK 字体支持（Chromium 截图）
- Skills 系统自动初始化

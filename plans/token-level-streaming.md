# Plan: Token-Level Streaming for Feishu

## 背景

当前 NanoClaw 的流式输出是 turn-level 的：Claude Agent SDK 的 `query()` 在整个 assistant turn 完成后才 yield `SDKAssistantMessage`，用户要等 10-30 秒才看到第一个字。

Agent SDK v0.2.68 提供了 `includePartialMessages: true` 选项，启用后会在 streaming 过程中额外 yield `SDKPartialAssistantMessage`（`type: 'stream_event'`），内含 Claude API 的原始 SSE 事件（`BetaRawMessageStreamEvent`），包括逐 token 的 `content_block_delta`。

OpenClaw 用类似机制实现了"秒回 + 逐字输出"，核心是一个 BlockChunker：攒到 800-1200 字符或遇到段落边界就 emit 一次，避免逐 token 打飞书 API 导致限流。

## SDK 类型参考

```typescript
// query options
includePartialMessages?: boolean;
// "When true, SDKPartialAssistantMessage events will be emitted during streaming."

type SDKPartialAssistantMessage = {
  type: 'stream_event';
  event: BetaRawMessageStreamEvent;  // Claude API 原始 SSE 事件
  parent_tool_use_id: string | null;
  uuid: UUID;
  session_id: string;
};

// BetaRawMessageStreamEvent 包含:
// - content_block_start
// - content_block_delta (delta.type === 'text_delta', delta.text === "几个token")
// - content_block_stop
// - message_start / message_delta / message_stop
```

## 改动文件

### 1. `container/agent-runner/src/index.ts`

**目标**: 启用 partial messages，实现 BlockChunker，输出 streaming chunks。

#### 1a. query options 加 `includePartialMessages: true`

位置：`runQuery()` 函数里的 `query()` 调用（约 L428）。

```typescript
for await (const message of query({
  prompt: stream,
  options: {
    // ... 现有选项 ...
    includePartialMessages: true,  // 新增
  }
})) {
```

#### 1b. 新增 BlockChunker 类

在文件顶部新增一个简单的 chunker。不需要做得像 OpenClaw 那么复杂，核心逻辑：

```typescript
class BlockChunker {
  private buffer = '';
  private readonly minChars: number;
  private readonly maxChars: number;

  constructor(minChars = 800, maxChars = 1200) {
    this.minChars = minChars;
    this.maxChars = maxChars;
  }

  /** 喂入 text delta，返回需要 emit 的文本（可能为空） */
  push(delta: string): string | null {
    this.buffer += delta;
    if (this.buffer.length < this.minChars) return null;

    // 在 maxChars 范围内找最佳断点
    const searchEnd = Math.min(this.buffer.length, this.maxChars);
    const searchRange = this.buffer.slice(0, searchEnd);

    // 断点优先级：段落 > 换行 > 句号 > 空格
    let breakIdx = searchRange.lastIndexOf('\n\n');
    if (breakIdx < this.minChars) breakIdx = searchRange.lastIndexOf('\n');
    if (breakIdx < this.minChars) {
      const sentenceMatch = searchRange.match(/.*[。.!?！？]/);
      breakIdx = sentenceMatch ? sentenceMatch[0].length : -1;
    }
    if (breakIdx < this.minChars && this.buffer.length >= this.maxChars) {
      breakIdx = searchRange.lastIndexOf(' ');
    }
    if (breakIdx < this.minChars && this.buffer.length >= this.maxChars) {
      breakIdx = this.maxChars; // 硬切
    }
    if (breakIdx < this.minChars) return null;

    const chunk = this.buffer.slice(0, breakIdx);
    this.buffer = this.buffer.slice(breakIdx);
    return chunk;
  }

  /** flush 剩余内容 */
  flush(): string | null {
    if (!this.buffer) return null;
    const chunk = this.buffer;
    this.buffer = '';
    return chunk;
  }

  /** 获取当前累积的全部文本（buffer 含已 push 但未 emit 的部分） */
  get fullText(): string {
    return this.buffer;
  }
}
```

#### 1c. 处理 `stream_event` 消息

在 `for await` 循环里，现有逻辑处理 `message.type === 'assistant'` 和 `message.type === 'result'`。新增对 `stream_event` 的处理：

```typescript
// 在 runQuery 函数顶部
let chunker = new BlockChunker();
let streamedFullText = '';  // 累积全部已发出的文本

for await (const message of query({...})) {
  // ... 现有的 messageCount++ 和日志 ...

  // 新增：token-level streaming
  if (message.type === 'stream_event') {
    const event = message.event;
    if (event.type === 'content_block_delta'
        && event.delta.type === 'text_delta') {
      const chunk = chunker.push(event.delta.text);
      if (chunk) {
        streamedFullText += chunk;
        writeOutput({
          status: 'success',
          result: streamedFullText,
          newSessionId,
          isStreaming: true,
        });
      }
    }
    // content_block_stop 或 message_stop 时 flush
    if (event.type === 'content_block_stop' || event.type === 'message_stop') {
      const remaining = chunker.flush();
      if (remaining) {
        streamedFullText += remaining;
        writeOutput({
          status: 'success',
          result: streamedFullText,
          newSessionId,
          isStreaming: true,
        });
      }
    }
    continue;  // 不走后面的 assistant/result 处理
  }

  // 现有的 assistant message 处理保留但简化
  if (message.type === 'assistant' && 'uuid' in message) {
    lastAssistantUuid = message.uuid;
    // 如果已经通过 stream_event 发过了，跳过重复发送
    // assistant message 还是会到达，但文本已经通过 stream_event 逐步发出了
    // 重置 chunker 为下一轮 tool use 后的新 assistant turn 做准备
    chunker = new BlockChunker();
    streamedFullText = '';
  }

  // result 处理保持不变
  if (message.type === 'result') { ... }
}
```

**注意**: `writeOutput` 发的 `result` 是**累积全文**而非 delta。这是因为 host 端 `_sendStreaming` 调用 `cardElement.content()` 是全量替换卡片内容，不是追加。当前机制已经是这样工作的（每次 streaming chunk 发的是当前完整文本）。

#### 1d. 重要细节

- `stream_event` 只出现在 assistant 生成文本时。tool_use、tool_result 等不会触发 `text_delta`。
- 一个 query 可能包含多轮 assistant turn（思考 → 调工具 → 继续写）。每轮新 assistant turn 开始时需要重置 chunker 和 streamedFullText。可以通过 `message_start` 事件来检测。
- `parent_tool_use_id` 可以区分是主 turn 还是子 agent 的输出，目前可以忽略，统一处理。

### 2. `src/index.ts` — 无需改动

现有的 `processSlotMessages` 已经正确处理 `result.isStreaming === true` 的情况（L387-396）。更频繁的 streaming chunks 会自动流经现有管道：

```
onOutput callback → channel.sendMessage → _sendStreaming → cardElement.content()
```

### 3. `src/channels/lark.ts` — 可选优化：限流

当前 `_sendStreaming` 每次调用都打一次飞书 API。token-level streaming 后调用频率会从"每 turn 1 次"变成"每 800-1200 字符 1 次"，大约每 3-5 秒一次，应该在飞书 API 限流范围内（通常 5 QPS）。

**如果遇到限流**，在 `_sendStreaming` 里加一个简单的 throttle：

```typescript
private lastStreamingUpdate = 0;
private pendingStreamingUpdate: ReturnType<typeof setTimeout> | null = null;

// 在 _sendStreaming 里：
const now = Date.now();
const MIN_UPDATE_INTERVAL = 300; // ms，飞书 API 安全间隔
if (now - this.lastStreamingUpdate < MIN_UPDATE_INTERVAL) {
  // 延迟到间隔结束后再更新
  if (!this.pendingStreamingUpdate) {
    this.pendingStreamingUpdate = setTimeout(() => {
      this.pendingStreamingUpdate = null;
      this._sendStreaming(jid, text, ...); // 用最新文本重试
    }, MIN_UPDATE_INTERVAL - (now - this.lastStreamingUpdate));
  }
  return;
}
this.lastStreamingUpdate = now;
```

但建议先不加，先测试看频率够不够用。BlockChunker 的 minChars=800 已经起到了自然限流的作用。

### 4. `src/container-runner.ts` — 无需改动

host 端解析 OUTPUT_MARKER 的逻辑不变。streaming chunks 更频繁地到达，但格式完全一样：

```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"累积全文...","isStreaming":true,"newSessionId":"..."}
---NANOCLAW_OUTPUT_END---
```

### 5. 容器重建

改完 agent-runner 后需要重建容器镜像：

```bash
./container/build.sh
```

## 预期效果

| 指标 | 改前 | 改后 |
|------|------|------|
| 首次可见输出 | 整个 turn 完成（10-30s） | 800 字符累积完成（3-5s） |
| 更新频率 | 每 turn 1 次 | 每 800-1200 字符 1 次 |
| 飞书 API 调用量 | 极少 | 适中（每次回复 3-10 次更新） |
| 代码改动量 | - | 仅 agent-runner/src/index.ts |

## 风险点

1. **SDK 版本兼容**: `includePartialMessages` 在 v0.2.34 可能不存在（package.json 写的是 `^0.2.34`，实际装的是 0.2.68）。建议在 package.json 里把最低版本提到 `^0.2.68`。
2. **飞书 API 限流**: BlockChunker 的 minChars 如果太小，可能触发限流。800 是保守值，可以根据实际情况调大。
3. **代码块被切断**: 简版 chunker 不处理 markdown 代码块边界。如果回复里有大段代码，可能在代码块中间切断。后续可以加代码块感知逻辑（检测未闭合的 ``` 对）。
4. **多轮 tool use**: 一个 query 里可能有多次 assistant turn（写文本 → 调工具 → 继续写）。每轮需要重置 chunker，通过 `message_start` 事件检测。

## 实施顺序

1. 改 `container/agent-runner/src/index.ts`（加 includePartialMessages + BlockChunker + stream_event 处理）
2. 更新 `container/agent-runner/package.json` 的 SDK 版本要求
3. `./container/build.sh` 重建镜像
4. 测试：发一条需要长回复的消息，观察飞书端是否逐段输出
5. 如有限流问题，再加 lark.ts 的 throttle

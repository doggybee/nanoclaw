# NanoClaw 云服务部署方案

基于 K8s + Google Agent Sandbox 的部署架构设计。适用于企业内部 10+ 并发的 Claude Code agent 集群。

---

## AI Agent 沙箱技术调研（2025-2026）

### 背景

NanoClaw 当前用 Docker 容器跑 agent，镜像 2.82GB，冷启动 7-14s。需要评估更轻量的沙箱方案，要求：安全隔离强、启动快、适合长时间运行的交互式 agent（不是跑完就销毁的一次性脚本）。

### 沙箱技术对比

| 技术 | 起源 | 冷启动 | 隔离级别 | K8s 原生 | 维护状态 | 适合 Agent? |
|------|------|--------|---------|---------|---------|------------|
| **Docker** | 2013, Docker Inc | 2-5s | namespace/cgroup（共享内核） | ✅ | 活跃 | ✅ 现状，够用 |
| **gVisor** | 2018, Google | 毫秒级 | 用户态内核（syscall 拦截） | ✅ RuntimeClass | 活跃，2026-02 最新版 | ✅ I/O 有 10-30% 损耗 |
| **Kata Containers** | 2017, Intel+Hyper→OpenStack | ~200ms | VM 级（独立内核） | ✅ RuntimeClass | 活跃，v3.5.0，Rust 重写中 | ✅ 最强隔离 |
| **Firecracker** | 2018, AWS | ~125ms | microVM（硬件虚拟化） | 需封装 | 活跃，AWS Lambda 底层 | ⚠️ 运维复杂 |
| **E2B** | 2023 | ~200ms | Firecracker | ❌ 外部 SaaS | 活跃 | ❌ 数据出境 |
| **Daytona** | 2024 | ~90ms(宣称) | Docker/OCI | ❌ | 活跃 | ⚠️ 隔离弱 |
| **Cloudflare Workers** | 2017 | ~1s | V8 isolate | ❌ | 活跃 | ❌ 不能跑 Node.js 全套 |

### Sandbank SDK 评估

[Sandbank](https://github.com/chekusu/sandbank) 不是沙箱技术本身，是统一多家沙箱提供商的 **抽象层 SDK**（类似 ORM 之于数据库）。

**架构**：`@sandbank.dev/core`（统一接口）→ adapter（Daytona/Fly.io/Cloudflare/BoxLite）

**核心接口**：`provider.create()` / `sandbox.exec()` / `sandbox.writeFile()` / `provider.destroy()`

**不适合 NanoClaw 直接使用的原因**：
- 抽象级别是 "远程执行命令"，NanoClaw 需要 "运行持续交互的进程"
- 无流式 token 输出（仅部分 adapter 支持 exec.stream）
- 无 warm pool 概念
- 无自定义网络拓扑（credential proxy, QMD proxy）

**值得借鉴的设计**：
- Provider 抽象模式 → 对应我们的运行时接口
- Skills 注入（写 .md 到 `~/.claude/skills/`）→ Skills Registry 直接复用
- Capability 检测 → 运行时探测 provider 能力

### 结论：Google Agent Sandbox

[Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox)（v0.1.1, 2026-02）是 Google 在 KubeCon NA 2025 发布的 K8s 原生 AI agent 沙箱方案，K8s SIG Apps 正式子项目（kubernetes-sigs/agent-sandbox）。1.2k stars, 35 contributors。

**为什么选它**：
1. 专为 AI agent 设计（长时间运行、有状态、单实例）
2. K8s 原生 CRD，不需要自己造轮子
3. 内置 WarmPool，冷启动 <1s
4. 隔离后端可插拔（gVisor / Kata），一行 runtimeClassName 切换
5. 自动生命周期管理（超时清理、shutdown timer）
6. Python SDK 已有，Go SDK 为主

---

## Agent Sandbox vs Docker（NanoClaw 视角）

| 维度 | Docker（现状） | Agent Sandbox on K8s |
|------|---------------|---------------------|
| **容器创建** | `docker run` + 手动参数拼装（container-runner.ts ~300 行） | `kubectl create SandboxClaim`，声明式 YAML |
| **预热池** | 手动管理 `warmPool[]`，代码 ~80 行，按活跃度补充 | SandboxWarmPool CRD，Controller 自动维持 poolSize |
| **超时清理** | `CONTAINER_TIMEOUT` + 手动 kill | `shutdownAfterSeconds` 声明式，Controller 自动执行 |
| **隔离级别** | namespace/cgroup（共享内核） | gVisor（用户态内核）或 Kata（独立内核 VM），一行切换 |
| **资源管理** | `--memory`/`--cpus` 手动传 | K8s resources.requests/limits，调度器自动分配 |
| **扩缩容** | `MAX_CONCURRENT_CONTAINERS` 硬上限 | WarmPool poolSize + K8s HPA，弹性伸缩 |
| **镜像分发** | 本机 docker build | Registry + 节点 DaemonSet 预拉取 |
| **健康检查** | 手动 check `.killed`/`.exitCode` | K8s livenessProbe/readinessProbe |
| **日志** | stdout/stderr + 自定义 marker 解析 | K8s 原生日志（kubectl logs） |
| **多机部署** | 不支持（单机 Docker） | K8s 原生多节点调度 |
| **存储** | bind mount 宿主机目录 | PVC（NFS/CephFS），Pod 漂移后数据不丢 |
| **网络** | host.docker.internal | K8s Service DNS（orchestrator.nanoclaw.svc） |

**代码变动**：
- 删除：warm pool 管理（~80 行）、docker run 参数构建（~150 行）、容器健康检查（~50 行）
- 新增：K8s API 调用 SandboxClaim（~30 行）
- 净减少 ~250 行容器管理代码

---

## K8s 部署架构（基于 Agent Sandbox）

### 设计原则

**最少组件、最小改动**。10+ 并发规模不需要微服务拆分。

Orchestrator 不拆成微服务，理由：
1. 10+ 并发，单进程完全够用
2. Credential Proxy / QMD Proxy 各几十行代码，独立成服务反而多运维负担
3. 这些组件共享内存状态（session、slot 队列），拆开后还得通过 DB/RPC 同步
4. 多一个组件 = 多一份部署、监控、日志、故障排查
5. 单点问题靠**快速恢复**解决，不靠拆服务

### 整体架构

```
              Ingress
              (Lark Webhook / API)
                    │
                    ▼
┌───────────────────────────────────────────┐
│          Orchestrator Pod                 │
│          (Deployment, 1 replica)          │
│                                           │
│  NanoClaw 主进程（与单机版结构一致）       │
│  ├── Lark Channel    :3000                │
│  ├── Credential Proxy :3001               │
│  ├── QMD Proxy        :3002               │
│  ├── gRPC Server      :50051              │
│  ├── Slot Router (SlotKey 双层限制)       │
│  ├── Session 管理                         │
│  └── Task Scheduler                       │
│                                           │
│  可靠性保障：                              │
│  ├── 内存状态全部可从 PG 重建 (<5s)       │
│  ├── K8s liveness 自动重启                │
│  └── Agent gRPC 自动重连                  │
└─────────────────┬─────────────────────────┘
                  │
      ┌───────────┼───────────┐
      │ gRPC      │ HTTP      │ HTTP
      │           │ (QMD)     │ (Cred)
      ▼           ▼           ▼
┌───────────┐ ┌───────────┐ ┌───────────┐
│ Sandbox A │ │ Sandbox B │ │ Sandbox C │
│ (group X) │ │ (group Y) │ │  (warm)   │
│           │ │           │ │           │
│ agent-    │ │ agent-    │ │ SDK 已    │
│ runner    │ │ runner    │ │ 初始化    │
│ Claude SDK│ │ Claude SDK│ │ 等待分配  │
│ Lark 直连 │ │ Lark 直连 │ │           │
│           │ │           │ │           │
│ runtime:  │ │ runtime:  │ │ runtime:  │
│ gvisor    │ │ gvisor    │ │ gvisor    │
└───────────┘ └───────────┘ └───────────┘
      │ Agent Sandbox Controller 管理
      │ (SandboxTemplate + SandboxWarmPool)
      │
      ▼
┌──────────────┐  ┌──────────────┐
│ PostgreSQL   │  │ PVC (NFS)    │
│ • messages   │  │ • groups/    │
│ • sessions   │  │ • skills/    │
│ • tasks      │  │ • sessions/  │
│ • groups     │  │   (.claude/) │
│ • router     │  │ • qmd/       │
└──────────────┘  └──────────────┘
```

**组件总数：Orchestrator (1 Pod) + Sandbox (N Pods) + PostgreSQL + PVC**

不需要：Redis、NATS、消息队列、Service Mesh、API Gateway。

### 数据流

**消息进入**：Lark → Ingress → Orchestrator → PostgreSQL → Slot Router → SandboxClaim → gRPC push → Agent

**流式输出（Agent 直连 Lark，不经 Orchestrator）**：Claude SDK token → ReplySession → Credential Proxy 拿 token → Lark CardKit API

**Claude API 调用**：Agent → 占位符 key → Credential Proxy (orchestrator.svc:3001) → 注入真实 key → api.anthropic.com

**IPC 操作（仅 chat_history、task 等少数操作）**：Agent → gRPC → Orchestrator → PostgreSQL → gRPC response

**语义搜索**：Agent → HTTP MCP → QMD Proxy (orchestrator.svc:3002) → per-group SQLite

---

## 与单机版的差异

| 改动项 | 单机 | K8s | 改动量 |
|--------|------|-----|--------|
| 容器管理 | `docker run` | SandboxClaim CRD | **重写** container-runner |
| Warm Pool | 手动 `warmPool[]` | SandboxWarmPool CRD | **删除**代码，换 YAML |
| IPC | 文件系统 watch | gRPC 双向流 | **重写** IPC 层 |
| DB | SQLite | PostgreSQL | **替换** db.ts |
| 文件挂载 | docker bind mount | PVC volumeMount | 配置 |
| 服务发现 | host.docker.internal | K8s Service DNS | 环境变量 |
| Agent 内部 | 不变 | 不变 | 0 |
| Lark 直连 | 不变 | 不变 | 0 |

**核心改动三块：SandboxClaim、gRPC IPC、PostgreSQL。** 其他都是配置。

---

## Orchestrator 可靠性

不拆服务，靠快速恢复保证可用性。

### 状态恢复（< 5 秒）

```typescript
async function recoverState() {
  // 1. 消息游标 — 从 PG router_state 表加载
  cursors = await db.getAllCursors();

  // 2. Session 映射 — 从 PG sessions 表加载
  sessions = await db.getAllSessions();

  // 3. 活跃 Sandbox — 从 K8s API 查存活的 Sandbox Pod
  const liveSandboxes = await k8sApi.listSandboxes({ namespace: 'nanoclaw' });
  for (const sb of liveSandboxes) {
    slots.set(sb.labels.slotKey, { sandboxId: sb.name, active: true });
  }

  // 4. Warm Pool — SandboxWarmPool Controller 自己管，无需恢复
  // 5. 未处理消息 — recoverPendingMessages() 已有
}
```

### Agent gRPC 自动重连

```typescript
async function connectWithRetry() {
  while (true) {
    try {
      const stream = client.Connect();
      await handleStream(stream);
    } catch (err) {
      // Orchestrator 重启期间，Claude SDK 调用不受影响（直连 API）
      // 只有 IPC 操作（chat_history、task）短暂不可用
      logger.warn('gRPC disconnected, reconnecting in 2s...');
      await sleep(2000);
    }
  }
}
```

### K8s 自动重启

```yaml
spec:
  replicas: 1
  strategy:
    type: Recreate
  template:
    spec:
      containers:
      - name: orchestrator
        livenessProbe:
          httpGet: { path: /health, port: 3000 }
          periodSeconds: 10
          failureThreshold: 3
        readinessProbe:
          httpGet: { path: /ready, port: 3000 }
```

**总恢复时间**：Pod 重启 (~3s) + 状态恢复 (~2s) = **~5 秒**。
重启期间：Agent 的 Claude API 调用和 Lark 直连不受影响，只有 IPC 操作暂停。

---

## Agent Sandbox CRD 资源

### SandboxTemplate

```yaml
apiVersion: agents.x-k8s.io/v1alpha1
kind: SandboxTemplate
metadata:
  name: nanoclaw-agent
  namespace: nanoclaw
spec:
  podTemplate:
    spec:
      runtimeClassName: gvisor
      containers:
      - name: agent
        image: nanoclaw-agent:latest
        resources:
          requests: { cpu: 250m, memory: 512Mi }
          limits:   { cpu: "1", memory: 2Gi }
        env:
        - name: ORCHESTRATOR_GRPC
          value: "orchestrator.nanoclaw.svc:50051"
        - name: NANOCLAW_QMD_URL
          value: "http://orchestrator.nanoclaw.svc:3002/mcp"
        - name: NANOCLAW_CRED_PROXY_URL
          value: "http://orchestrator.nanoclaw.svc:3001"
      volumes:
      - name: group-data
        persistentVolumeClaim:
          claimName: nanoclaw-groups
      - name: skills
        persistentVolumeClaim:
          claimName: nanoclaw-skills
```

### SandboxWarmPool

```yaml
apiVersion: agents.x-k8s.io/v1alpha1
kind: SandboxWarmPool
metadata:
  name: nanoclaw-warm
  namespace: nanoclaw
spec:
  templateRef:
    name: nanoclaw-agent
  poolSize: 3
  shutdownAfterSeconds: 1800
```

---

## IPC：文件系统 → gRPC 双向流

```protobuf
service AgentOrchestrator {
  rpc Connect(stream AgentMessage) returns (stream OrchestratorMessage);
  rpc IpcCall(IpcRequest) returns (IpcResponse);
}
```

| 现有文件 IPC | gRPC 替代 |
|-------------|-----------|
| `input/*.json`（host→agent） | `OrchestratorMessage.message` |
| stdout marker 解析 | `AgentMessage.streaming` |
| `messages/*.json`（agent→host） | `IpcCall()` |
| `responses/{id}.json` | `IpcCall()` return |
| `_close` 文件 | `OrchestratorMessage.close` |

---

## 存储策略

| 数据 | 单机 | K8s | 说明 |
|------|------|-----|------|
| messages, sessions, groups, tasks | SQLite | PostgreSQL | 多 Pod 访问 |
| groups/（CLAUDE.md, conversations/） | bind mount | PVC (RWX) | 中频读写，NFS 可接受 |
| sessions/（.claude/ JSONL） | bind mount | PVC (RWX) | 高频写，后续可优化为 S3 + 本地缓存 |
| skills/ | bind mount | PVC (ROX) | 只读 |
| QMD 索引 | 本地文件 | Orchestrator Pod 本地 | 不共享 |

**PVC 说明**：PersistentVolumeClaim 是 K8s 的持久存储抽象。Pod 声明 "我要 N GB 可读写空间"，K8s 分配底层存储（NFS、CephFS、云盘等）。NanoClaw 需要 ReadWriteMany（多 Pod 同时读写同一存储），需要 NFS 或 CephFS 支持。

---

## 分阶段路线

### Phase 3a：单机上验证 gRPC IPC
- IPC 从文件改为 gRPC（agent 通过 localhost 连 orchestrator）
- db.ts 提取 StateStore 接口（为 PG 替换做准备）
- 不改部署方式，验证可行性

### Phase 3b：K8s 最小可用
- 安装 Agent Sandbox CRD + Controller
- Orchestrator → Deployment (1 replica)
- container-runner.ts → SandboxClaim 调用
- PostgreSQL 替代 SQLite
- PVC 挂载 groups/、skills/、sessions/
- gVisor 起步（需要更强隔离时切 Kata）

### Phase 3c：按需优化
- Session JSONL 改为 emptyDir + S3（解决 NFS I/O 瓶颈）
- PG LISTEN/NOTIFY 替代消息轮询（延迟 500ms → 10ms）
- WarmPool poolSize 按时段动态调整
- 分级 SandboxTemplate（轻量/标准/重度）

---

## 不需要改的

- 消息路由逻辑（SlotKey、双层并发限制）
- 模型路由、session 管理逻辑
- Agent SDK 调用方式（容器内 agent-runner 只换 IPC 层）
- 记忆层次（四层）设计
- Lark 直连（Agent → Lark API，不经 orchestrator）
- QMD 集中化方案（host.docker.internal → K8s Service DNS）
- Skills 注入（bind mount → PVC mount）

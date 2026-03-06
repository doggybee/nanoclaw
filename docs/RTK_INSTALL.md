# RTK (Rust Token Killer) 安装指南

RTK 是一个 CLI 代理，压缩命令输出以减少 60-90% 的 LLM token 消耗。纯本地运行，不需要外网。

## 在线环境安装

```bash
# 宿主机
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# Claude Code 集成
rtk init --global
# 按提示将 hooks 配置加入 ~/.claude/settings.json
```

容器内的 RTK 由 Dockerfile 自动安装，无需手动操作。

## 内网离线安装

### 1. 准备二进制（在有网的机器上）

```bash
# Linux x86_64
curl -fsSL -o rtk.tar.gz https://github.com/rtk-ai/rtk/releases/latest/download/rtk-x86_64-unknown-linux-musl.tar.gz

# Linux ARM64
curl -fsSL -o rtk.tar.gz https://github.com/rtk-ai/rtk/releases/latest/download/rtk-aarch64-unknown-linux-gnu.tar.gz
```

将 `rtk.tar.gz` 拷贝到内网机器。

### 2. 安装到宿主机

```bash
tar xzf rtk.tar.gz -C ~/.local/bin/
chmod +x ~/.local/bin/rtk
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
rtk --version
```

### 3. Claude Code 集成（宿主机）

```bash
rtk init --global
```

如果 `rtk init` 不可用（离线），手动配置：

将 `container/rtk/rtk-rewrite.sh` 复制到 `~/.claude/hooks/`，将 `container/rtk/RTK.md` 复制到 `~/.claude/`：

```bash
mkdir -p ~/.claude/hooks
cp container/rtk/rtk-rewrite.sh ~/.claude/hooks/
cp container/rtk/RTK.md ~/.claude/
chmod +x ~/.claude/hooks/rtk-rewrite.sh
```

在 `~/.claude/settings.json` 中添加 hooks：

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "<HOME_DIR>/.claude/hooks/rtk-rewrite.sh"
      }]
    }]
  }
}
```

### 4. 容器镜像

Dockerfile 已包含 RTK 安装步骤。内网构建时需要提前准备：

1. 将 `rtk.tar.gz` 放到 `container/` 目录
2. 修改 Dockerfile 中 RTK 安装步骤为本地 COPY：

```dockerfile
# 替换原来的 curl 下载
COPY rtk.tar.gz /tmp/rtk.tar.gz
RUN tar xzf /tmp/rtk.tar.gz -C /usr/local/bin rtk \
    && chmod +x /usr/local/bin/rtk \
    && rm /tmp/rtk.tar.gz
```

3. 重新构建：`./container/build.sh`

### 5. 验证

```bash
# 宿主机
rtk --version
rtk gain

# 容器内
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c "rtk --version"
```

## 工作原理

RTK 通过 Claude Code 的 PreToolUse hook 自动拦截 Bash 命令：

```
git status → rtk git status (输出被压缩)
npm test   → rtk test npm test (去重复、折叠)
```

agent 看到的是精简后的输出，命令本身不受影响。每次额外开销 <10ms。

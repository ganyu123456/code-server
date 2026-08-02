# AI 智能体对话面板

## 1. 背景与动机

### 1.1 现状与可行性验证

code-server 内嵌的 VS Code（当前 v1.131.0）提供了以下能力：

- 活动栏 Chat 图标（`Cmd+Shift+I` / `Ctrl+Shift+I`）
- 原生 Chat 面板（Markdown 渲染、代码高亮、历史记录）
- WebviewView 侧边栏 API（`vscode.window.registerWebviewViewProvider`）

但是，本项目的 **Chat Participant API 方案已被验证不可行**：

| 尝试项 | 结果 | 原因 |
|---|---|---|
| `chatParticipants` + `isDefault` | ❌ 激活但报错 | "cannot register without path" |
| `chatParticipants` → `chatAgents` | ❌ 同上 | 同上 |
| `chatParticipants` + `fullName` | ❌ 同上 | 同上 |
| `chatParticipants` → `chatParticipant` | ❌ 同上 | 同上 |
| `languageModelChatProviders` | ⚠️ 激活不报错 | 端到端未验证 |

**根因**：在 VS Code for the web 环境中，`$registerAgent` 需要扩展文件通过 HTTP 可访问才能读取 manifest 中的 chat participant 声明。本地 `.vsix` 安装的扩展无法提供这个 path，因此被拒绝。

### 1.2 业界最佳实践调研

| 项目 | 授权 | 方案 | 参考价值 |
|---|---|---|---|
| **Cline** | Apache 2.0 | WebviewView + React + postMessage | WebviewView 模式的标准参考实现 |
| **forge (Enclave)** | MIT | ChatParticipant → WebviewView 迁移 | 完整记录了同一困境的解决路径 |
| **claude-code-chat** | MIT | WebviewView + spawn claude CLI | CLI 进程管理 + webview 渲染 |
| **Trae (ByteDance)** | 闭源 | VS Code Electron fork + 实验性 API | 架构思路参考（不适合 code-server） |

**结论**：WebviewView + CLI 后端 + postMessage 流式通信 是经过多个项目验证的最佳实践。

### 1.3 设计原则

- **复用成熟模式**：WebviewView 参考 Cline/forge，Agent 抽象层保留上一版设计
- **Agent 可替换**：通过统一抽象接口支持多种 Agent 后端
- **UI 渐进增强**：Phase 1 轻量 HTML/CSS/JS，Phase 2 可升级为 React
- **配置可视化**：模型、Agent 通过 VS Code Settings 管理
- **零额外依赖启动**：扩展 .vsix 随 code-server 打包，启动时自动安装

## 2. Agent 后端支持规划

### 2.1 目标 Agent 列表

| Agent | 类型 | 连接方式 | 实现阶段 |
|---|---|---|---|
| OpenCode | 本地 CLI（`opencode serve`） | HTTP + SSE 流式 | Phase 1（当前） |
| Claude Code | 本地 CLI（`claude`） | 本地进程 stdio | Phase 2 |
| Codex | 本地 CLI / 远程 API | HTTP / WebSocket | Phase 2 |
| Hermes | 本地 CLI / 远程 API | HTTP / WebSocket | Phase 2 |

### 2.2 Agent 抽象层设计

```typescript
interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  install(): Promise<void>;
  isInstalled(): Promise<boolean>;
  start(config: AgentConfig): Promise<void>;
  stop(): Promise<void>;
  chat(messages: ChatMessage[], context: ChatContext): AsyncIterable<ChatResponse>;
  healthCheck(): Promise<boolean>;
  listModels(): Promise<ModelInfo[]>;
}
```

### 2.3 配置结构

```yaml
# ~/.config/code-server/config.yaml
extensions-dir: /home/coder/.local/share/code-server/extensions

ai:
  agent:
    defaultProvider: opencode      # opencode | claudecode | codex | hermes

  opencode:
    autoStart: true
    autoInstall: true
    port: 4096
    model:
      provider: openai             # openai | anthropic | openrouter | ollama | custom
      apiKey: ${OPENAI_API_KEY}
      baseUrl: https://api.openai.com/v1
      model: gpt-4o
      temperature: 0.7
      maxTokens: 4096
```

### 2.4 多用户隔离

同一 code-server 实例的多个 session，每人启动独立的 Agent 进程。Agent 监听端口 = `basePort + (pid % 100)`。

## 3. 架构设计

### 3.1 WebviewView 方案 vs Chat Participant 方案

| 维度 | Chat Participant（旧） | WebviewView（新） |
|---|---|---|
| 是否需 Copilot | 是 | **否** |
| web VS Code 兼容 | 否 | **是** |
| UI 控制 | 原生 Chat 面板 | 自定义 webview |
| 流式渲染 | `stream.markdown()` | 自定义 SSE → DOM |
| 参考实现 | — | Cline / forge / claude-code-chat |
| 实现复杂度 | 低（桥接） | 中（需写 UI） |

### 3.2 整体架构

```
┌──────────────────────────────────────────────────────────┐
│  Browser                                                  │
│  ┌────────────────────────────────────────────────────┐  │
│  │  VS Code Workbench                                  │  │
│  │                                                     │  │
│  │  ┌──────────────┐    ┌──────────────────────────┐  │  │
│  │  │  编辑器区域    │    │  AI Chat 面板 (Webview)    │  │  │
│  │  │              │    │  ┌────────────────────┐   │  │  │
│  │  │              │    │  │  HTML/CSS/JS        │   │  │  │
│  │  │              │    │  │  - 消息列表          │   │  │  │
│  │  │              │    │  │  - 输入框            │   │  │  │
│  │  │              │    │  │  - Markdown 渲染     │   │  │  │
│  │  │              │    │  │  - 流式输出          │   │  │  │
│  │  │              │    │  └────────┬───────────┘   │  │  │
│  │  └──────────────┘    └───────────┼───────────────┘  │  │
│  └───────────────────────────────────┼──────────────────┘  │
└──────────────────────────────────────┼─────────────────────┘
                                       │ postMessage
                          ┌────────────▼──────────────────────┐
                          │  AI Agent Extension (本方案实现)     │
                          │                                    │
                          │  WebviewViewProvider               │
                          │  - 管理 webview 生命周期             │
                          │  - postMessage 双向通信             │
                          │  - Agent 进程生命周期管理            │
                          │  - 消息转发与流式响应                │
                          └────────────┬───────────────────────┘
                                       │ HTTP + SSE
                          ┌────────────▼───────────────────────┐
                          │  Agent 后端 (opencode serve)        │
                          │  - 对话引擎                          │
                          │  - 工具调用                          │
                          └────────────┬───────────────────────┘
                                       │ HTTPS
                          ┌────────────▼───────────────────────┐
                          │  LLM Provider                       │
                          │  (OpenAI / Anthropic / DeepSeek)    │
                          └─────────────────────────────────────┘
```

### 3.3 通信链路

| 链路 | 协议 | 说明 |
|---|---|---|
| Webview ↔ Extension | postMessage | 双向消息传递 |
| Extension ↔ Agent | HTTP + SSE | opencode serve 的 OpenAI 兼容 API |
| Agent ↔ LLM | HTTPS | 模型调用（通过 OPENAI_API_KEY 等环境变量配置） |

### 3.4 Webview 消息协议

**Extension → Webview (ExtensionMessage)**：

```typescript
type ExtensionMessage =
  | { type: 'response'; content: string; partial: boolean }  // 流式响应块
  | { type: 'error'; message: string }                       // 错误
  | { type: 'status'; status: 'connecting' | 'ready' | 'error' }
  | { type: 'modelInfo'; models: ModelInfo[] }
```

**Webview → Extension (WebviewMessage)**：

```typescript
type WebviewMessage =
  | { type: 'chat'; message: string }          // 用户发送消息
  | { type: 'command'; command: string }       // 斜杠命令
  | { type: 'cancel' }                         // 取消当前请求
  | { type: 'switchAgent'; agentId: string }   // 切换 Agent
```

### 3.5 启动流程

```
code-server 启动
  │
  ├─ 读取 config.yaml → 获取扩展目录和 Agent 配置
  │
  ├─ main.ts: 检查 ai-agent 扩展是否已安装
  │     └─ 未安装 → 从 extensions/ai-agent.vsix 自动安装
  │
  ├─ VS Code Extension Host 激活 ai-agent 扩展
  │     ├─ 注册 WebviewViewProvider (侧边栏 Chat 面板)
  │     ├─ 检查 Agent CLI 是否已安装
  │     │     └─ 未安装且 autoInstall → 执行安装脚本
  │     ├─ 若 autoStart → spawn Agent 服务进程
  │     │     └─ 轮询健康检查 → 通过后标记就绪
  │     ├─ 监听 postMessage ← webview
  │     └─ 注册配置项到 VS Code Settings
  │
  └─ 用户点击侧边栏图标 → Chat 面板打开 → 直接输入 → 对话
```

### 3.6 流式对话流程

```
用户输入消息 → webview postMessage('chat', text)
  → Extension 收到 → HTTP POST opencode serve /v1/chat/completions
  → SSE 流式读取响应 chunks
  → 每个 chunk → postMessage('response', delta, partial: true)
  → webview 渲染 Markdown（带闪烁光标）
  → 流结束 → postMessage('response', '', partial: false)
  → webview 移除光标
```

## 4. 详细功能设计

### 4.1 Chat 面板

| 功能 | 实现方式 |
|---|---|
| 侧边栏入口 | 活动栏图标 + `Cmd+Shift+I` / `Ctrl+Shift+I` |
| 消息输入 | textarea + Enter 发送 / Shift+Enter 换行 |
| Markdown 渲染 | marked.js (轻量，~20KB) |
| 代码高亮 | highlight.js (轻量，可按语言裁剪) |
| 流式渲染 | SSE → 逐 chunk 追加 DOM，带闪烁光标 |
| 斜杠命令 | `/explain`、`/fix`、`/test`、`/doc` |
| 对话历史 | 存储在 webview sessionStorage，刷新保留 |
| 模型选择 | 下拉框，从 Agent 获取可用模型列表 |

### 4.2 上下文注入

- 当前编辑器选区 → 自动附加为 context
- `#file` 引用 → 读取文件内容注入 prompt
- 未来：终端输出、诊断信息、Git diff

### 4.3 模型提供商配置

| 提供商 | model.provider | 说明 |
|---|---|---|
| OpenAI | `openai` | GPT-4o、GPT-4.1 等 |
| DeepSeek | `openai` | 设置 `baseUrl: https://api.deepseek.com/v1`，兼容 OpenAI 协议 |
| Anthropic | `anthropic` | Claude 系列 |
| OpenRouter | `openrouter` | 统一网关 |
| Ollama | `ollama` | 本地部署 |
| 自定义 | `custom` | 兼容 OpenAI API 协议的服务 |

### 4.4 扩展设置

| 配置键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `ai-agent.defaultProvider` | enum | `opencode` | 默认 Agent |
| `ai-agent.opencode.autoStart` | boolean | true | 启动时自动启动 Agent |
| `ai-agent.opencode.autoInstall` | boolean | true | 自动安装 CLI |
| `ai-agent.opencode.port` | number | 4096 | Agent 服务端口 |
| `ai-agent.opencode.model.provider` | enum | `openai` | 模型提供商 |
| `ai-agent.opencode.model.apiKey` | string | `""` | API Key（支持 `${ENV}`） |
| `ai-agent.opencode.model.baseUrl` | string | `""` | 自定义 API 地址 |
| `ai-agent.opencode.model.model` | string | `gpt-4o` | 模型名称 |
| `ai-agent.opencode.model.temperature` | number | 0.7 | 温度 (0-2) |
| `ai-agent.opencode.model.maxTokens` | number | 4096 | 最大输出 |

### 4.5 扩展分发

- 仅作为 code-server 内置组件分发，不上架 VS Code Marketplace
- `.vsix` 文件随源码存放于 `extensions/ai-agent/`
- code-server 启动时通过 `main.ts` 自动检测并安装到用户扩展目录

## 5. 与业界产品对标

| 维度 | GitHub Codespaces | Cline | 本方案 |
|---|---|---|---|
| 对话入口 | `Cmd+Shift+I` | 侧边栏图标 | 侧边栏图标 |
| AI 后端 | Copilot（固定） | 33+ 提供商 | OpenCode / Claude Code 等 |
| 模型选择 | Copilot 内置 | 用户配置 | 用户配置 |
| 数据去向 | GitHub 服务器 | 用户自选 | 用户自控 |
| 架构模式 | Chat Participant (原生) | WebviewView + React | WebviewView + 轻量 UI |
| code-server 兼容 | 否 | 是 | 是 |
| 开源 | 否 | Apache 2.0 | MIT |
| MCP 支持 | 否 | 是 | Phase 2 |

## 6. 实施计划

### Phase 1：OpenCode + WebviewView（当前阶段）

**目标**：用户在 code-server 侧边栏中打开 Chat 面板，选择模型后与 AI 对话。

**交付物**：

1. 重写 `extensions/ai-agent` 扩展
   - 将 `vscode.chat.createChatParticipant` 替换为 `vscode.window.registerWebviewViewProvider`
   - 移除 `package.json` 中的 `chatParticipants` 贡献
   - 新增 `viewsContainers` + `views` 贡献
   - 创建 `media/chat.html` — 聊天 webview UI（~150 行）
   - 创建 `media/chat.js` — webview 逻辑（消息渲染、SSE 流式处理，~200 行）
   - 创建 `media/chat.css` — VS Code 主题样式（~100 行）
   - 保留并改进 `opencode-adapter.ts`（Agent 进程管理 + HTTP 代理）
   - postMessage 协议实现

2. code-server 集成
   - 修复 `src/node/main.ts` 扩展自动安装逻辑
   - 修复 Dockerfile.codex 中 opencode 路径（`/root/.opencode/bin/opencode`）
   - 修复 `.dockerignore` 添加 `!ai-agent.vsix`
   - 扩展安装到用户扩展目录 + `extensions-dir` 写入 config.yaml

3. Docker 镜像
   - 在宿主机预编译 `.vsix`，Dockerfile 中 COPY 并安装
   - 环境变量注入 API Key（`OPENAI_API_KEY`、`OPENAI_BASE_URL`）

4. 测试验证
   - 端到端：启动容器 → 打开浏览器 → 侧边栏 Chat 面板可用 → 发送消息 → 收到流式回复
   - 多模型：OpenAI / DeepSeek / Ollama 各测试一次

**预计工作量**：5-7 个工作日

### Phase 2：多 Agent + MCP

- AgentAdapter 抽象层实现
- Claude Code、Codex、Hermes 适配器
- Agent 切换面板
- MCP Server Webview 管理

### Phase 3：深度集成

- 终端错误一键发送到 Chat
- 代码诊断作为上下文
- 自定义斜杠命令
- 对话历史导出与搜索

## 7. 参考项目

| 项目 | 仓库 | 关键参考点 |
|---|---|---|
| Cline | `https://github.com/cline/cline` | WebviewViewProvider + React + postMessage |
| forge | `https://github.com/robpitcher/forge` | ChatParticipant → WebviewView 迁移 |
| claude-code-chat | `https://github.com/codeflow-studio/claude-code-chat` | WebviewView + CLI spawn |
| Trae | ByteDance 闭源 | VS Code fork 层面扩展注入 |

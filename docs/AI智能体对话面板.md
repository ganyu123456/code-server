# AI 智能体对话面板

## 1. 背景与动机

### 1.1 已有基础

code-server 内嵌的 VS Code（当前 v1.131.0）已经内置了完整的 **Chat 基础设施**，包括：

- 活动栏 Chat 图标（`Cmd+Shift+I` / `Ctrl+Shift+I`）
- 右侧/底部对话面板（支持拖拽、折叠、调整宽度）
- 多轮对话界面（Markdown 渲染、代码高亮、历史记录）
- 斜杠命令系统（`/explain`、`/fix`、`/test` 等）
- 上下文感知（`#file`、`#selection`、当前编辑器）
- 内联聊天（`Cmd+I` 在编辑器内直接对话）
- 代码 diff 预览与一键应用

这些能力通过 VS Code 的 **Chat Participant API**（`vscode.chat`）对外暴露。GitHub Copilot Chat 本质上就是一个 Chat Participant 扩展，Continue、Cline、Cody 等也使用同一套 API。

### 1.2 我们还需要什么

用户当前的 code-server 虽然能看到 Chat 面板，但没有可用的 AI 后端，面板是空的。本方案的目标是：

**编写一个 Chat Participant 扩展，桥接 VS Code Chat API 与外部 AI Agent 后端，让用户在 code-server 中开箱即用地与 AI 对话编程。**

用户打开 Chat 面板后直接输入即可对话，无需输入 `@` 前缀——Agent 被配置为默认参与者，体验与 GitHub Codespaces 完全一致。

### 1.3 设计原则

- **不重复造轮子**：Chat UI 完全复用 VS Code 原生框架，本扩展只做桥接
- **Agent 可替换**：不锁定单一 AI 服务商，支持多种 Agent 后端
- **默认即对话**：用户打开面板即用，无需学习 `@` 前缀等调用方式
- **配置可视化**：模型、Agent、MCP 均通过 VS Code Settings 管理
- **零额外依赖启动**：首次启动 code-server 时自动安装 Agent 并加载扩展

## 2. Agent 后端支持规划

### 2.1 目标 Agent 列表

| Agent | 类型 | 连接方式 | 实现阶段 |
|---|---|---|---|
| OpenCode | 本地 CLI（`opencode serve`） | HTTP REST + SSE 流式 | Phase 1（当前） |
| Claude Code | 本地 CLI（`claude`） | 本地进程 stdio | Phase 2 |
| Codex | 本地 CLI / 远程 API | HTTP / WebSocket | Phase 2 |
| Hermes | 本地 CLI / 远程 API | HTTP / WebSocket | Phase 2 |

### 2.2 Agent 抽象层设计

所有 Agent 后端通过统一抽象接口接入：

```typescript
interface AgentAdapter {
  /** Agent 标识符 */
  readonly id: string;
  /** 人类可读名称 */
  readonly displayName: string;
  /** 安装 Agent CLI */
  install(): Promise<void>;
  /** 检查 Agent CLI 是否已安装 */
  isInstalled(): Promise<boolean>;
  /** 启动 Agent 进程（如需要） */
  start(config: AgentConfig): Promise<void>;
  /** 停止 Agent 进程 */
  stop(): Promise<void>;
  /** 发送对话请求，返回流式响应 */
  chat(messages: ChatMessage[], context: ChatContext): AsyncIterable<ChatResponse>;
  /** 健康检查 */
  healthCheck(): Promise<boolean>;
  /** 获取可用模型列表 */
  listModels(): Promise<ModelInfo[]>;
}
```

不同类型的 Agent 后端实现各自的 `AgentAdapter`，Chat Participant 扩展只依赖这个抽象接口，不关心具体后端是谁。

### 2.3 默认 Agent 机制

扩展注册 Chat Participant 时将其设为默认参与者。当只有 OpenCode 一个 Agent 时，它自动成为默认值；当配置了多个 Agent 时，通过 `ai.agent.defaultProvider` 指定默认值。用户**直接输入即可对话**，无需 `@opencode` 前缀。

当用户需要临时切换到其他 Agent 时，可通过 `@agent-name` 前缀显式调用（如 `@claudecode 解释这段代码`）。

### 2.4 配置结构

```yaml
# ~/.config/code-server/config.yaml
ai:
  # 默认 Agent（用户直接对话使用的 Agent）
  agent:
    defaultProvider: opencode      # opencode | claudecode | codex | hermes

  # OpenCode 配置
  opencode:
    autoStart: true                # code-server 启动时自动启动 opencode serve
    autoInstall: true              # 未检测到 CLI 时自动执行安装脚本
    port: 4096                     # opencode serve 监听端口
    startCommand: opencode serve   # 启动命令（可选覆盖）
    model:
      provider: openai             # openai | anthropic | openrouter | ollama | custom
      apiKey: ${OPENAI_API_KEY}
      baseUrl: https://api.openai.com/v1
      model: gpt-4o
      temperature: 0.7
      maxTokens: 4096

  # Claude Code 配置（Phase 2）
  claudecode:
    autoStart: false               # 非默认 Agent 默认不自动启动
    autoInstall: true
    model:
      provider: anthropic
      apiKey: ${ANTHROPIC_API_KEY}
      model: claude-sonnet-4-5-20250929

  # Codex 配置（Phase 2）
  codex:
    autoStart: false
    autoInstall: true
    port: 4097

  # Hermes 配置（Phase 2）
  hermes:
    autoStart: false
    autoInstall: true
    port: 4098

  # MCP Server 配置
  mcp:
    servers:
      - name: filesystem
        command: npx
        args: ["-y", "@anthropic/mcp-server-filesystem", "/workspace"]
        enabled: true
      - name: github
        command: npx
        args: ["-y", "@anthropic/mcp-server-github"]
        env:
          GITHUB_TOKEN: ${GITHUB_TOKEN}
        enabled: false
```

## 3. 详细功能需求

### 3.1 Chat 对话体验

**（以下功能 80% 由 VS Code Chat API 原生提供，本扩展只负责与 Agent 后端的桥接逻辑）**

| 功能 | 实现方式 |
|---|---|
| Chat 面板入口 | VS Code 原生，活动栏图标 + `Cmd+Shift+I` |
| 直接对话（无需前缀） | VS Code Chat API 默认 Participant 机制 |
| 多轮对话 | VS Code 原生 Chat 面板 |
| Markdown 渲染 / 代码高亮 | VS Code 原生 |
| 斜杠命令（`/explain`、`/fix` 等） | VS Code Chat API `request.command` |
| 上下文引用（`#file`、`#selection`） | VS Code Chat API `request.references` |
| 内联聊天（`Cmd+I`） | VS Code 原生 |
| 消息流式输出 | VS Code Chat API `stream.markdown()` |
| 代码 diff 预览与一键应用 | VS Code Chat API `stream.button()` + 自定义 Command |
| 对话历史 | VS Code 原生（存储在 globalState） |
| 切换到其他 Agent | `@agent-name` 显式调用 |

扩展需要实现的核心逻辑：

1. **注册默认 Chat Participant**：设为默认，用户打开面板即可直接对话
2. **管理 Agent 进程生命周期**：激活时启动 Agent 服务，停用时 kill；每个用户独立 Agent 进程
3. **Agent 自动安装**：检测到 Agent CLI 未安装时，自动执行安装脚本
4. **消息转发**：将 Chat API 的请求转换为 Agent 后端的 HTTP 请求
5. **流式响应**：将 Agent 后端的 SSE 流转换为 `stream.markdown()` 调用
6. **上下文注入**：将 `request.references` 中的文件/选区内容注入到请求中

### 3.2 模型提供商配置

通过 VS Code 原生 `contributes.configuration` 提供设置界面。用户在 VS Code Settings（`Cmd+,`）中搜索 `ai-agent` 即可看到所有配置项。

**支持的模型提供商：**

| 提供商 | model.provider 值 | 说明 |
|---|---|---|
| OpenAI | `openai` | 通过 OpenAI API，支持 GPT-4o、GPT-4.1 等 |
| Anthropic | `anthropic` | 通过 Anthropic API，支持 Claude 系列 |
| OpenRouter | `openrouter` | 统一网关，支持多模型 |
| Ollama | `ollama` | 本地部署，需配置 `baseUrl`（默认 `http://127.0.0.1:11434`） |
| 自定义 | `custom` | 兼容 OpenAI API 协议的任意服务 |

**本地模型（Ollama）专门配置项：**

| 配置键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `opencode.model.provider` | string | `openai` | 选择 `ollama` |
| `opencode.model.baseUrl` | string | `http://127.0.0.1:11434` | Ollama 服务地址 |
| `opencode.model.model` | string | `codellama` | 模型名称（如 `codellama`、`qwen2.5-coder` 等） |

### 3.3 设置管理

**核心配置项：**

| 配置键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `ai-agent.defaultProvider` | enum | `opencode` | 默认 Agent，用户直接对话使用的后端 |
| `ai-agent.opencode.enabled` | boolean | true | 启用/禁用 OpenCode Agent |
| `ai-agent.opencode.autoStart` | boolean | true | code-server 启动时自动启动 Agent |
| `ai-agent.opencode.autoInstall` | boolean | true | 未检测到 CLI 时自动安装 |
| `ai-agent.opencode.port` | number | 4096 | Agent 服务监听端口 |
| `ai-agent.opencode.startCommand` | string | `opencode serve` | 自定义启动命令 |
| `ai-agent.opencode.model.provider` | enum | `openai` | 模型提供商 |
| `ai-agent.opencode.model.apiKey` | string | `""` | API Key（支持 `${ENV_VAR}` 语法） |
| `ai-agent.opencode.model.baseUrl` | string | `""` | 自定义 API 地址 |
| `ai-agent.opencode.model.model` | string | `gpt-4o` | 模型名称 |
| `ai-agent.opencode.model.temperature` | number | 0.7 | 温度参数（0-2） |
| `ai-agent.opencode.model.maxTokens` | number | 4096 | 最大输出 token |

### 3.4 MCP Server 管理

通过 `config.yaml` 声明式配置 MCP Server，修改后重启生效。后续 Phase 2 提供可视化 Webview 管理。

```yaml
ai:
  mcp:
    servers:
      - name: filesystem
        command: npx
        args: ["-y", "@anthropic/mcp-server-filesystem", "/workspace"]
        enabled: true
```

### 3.5 配置持久化

- 扩展配置通过 VS Code 的 `contributes.configuration` 定义，由 VS Code 自动持久化到 `settings.json`
- Agent 级别的配置（MCP、模型参数等）写入 `~/.config/code-server/config.yaml`
- 环境变量引用（`${VAR}` 语法）支持从宿主环境注入密钥，避免明文存储

### 3.6 Agent 自动安装与预装机制

**Agent CLI 自动安装：**

- 扩展激活时，对默认 Agent 执行 `isInstalled()` 检查
- 若 `autoInstall: true` 且 CLI 未安装，自动调用安装脚本
- 安装脚本由各 Agent 适配器的 `install()` 方法定义（如 OpenCode 的 `curl -fsSL https://opencode.ai/install.sh | sh`）
- 安装失败时在 Chat 面板中显示错误提示，不阻塞 code-server 正常运行

**扩展预装机制：**

1. **内置打包**：`ai-agent` 扩展的 `.vsix` 文件随 code-server 发布，放在 `lib/extensions/ai-agent.vsix`
2. **仅内置分发**：扩展仅作为 code-server 内置组件发布，不上架 VS Code Marketplace
3. **自动安装**：code-server 启动时检查扩展是否已安装，未安装则执行 `--install-extension`

### 3.7 多用户隔离

同一 code-server 实例的多个用户（多 session），每人启动独立的 Agent 进程。Agent 进程监听不同端口（如 `port + sessionIndex`），进程间完全隔离，互不影响。

## 4. 架构设计

### 4.1 整体架构

```
┌──────────────────────────────────────────────────────────┐
│  Browser                                                  │
│  ┌────────────────────────────────────────────────────┐  │
│  │  VS Code Workbench                                  │  │
│  │                                                     │  │
│  │  ┌──────────────┐    ┌──────────────────────────┐  │  │
│  │  │  编辑器区域    │    │  Chat 面板（原生）         │  │  │
│  │  │              │    │  ┌────────────────────┐   │  │  │
│  │  │              │    │  │  用户直接输入对话     │   │  │  │
│  │  │              │    │  │  → 发送到默认 Agent  │   │  │  │
│  │  │              │    │  │  斜杠命令 /explain   │   │  │  │
│  │  │              │    │  │  #file 引用          │   │  │  │
│  │  └──────────────┘    │  └────────┬───────────┘   │  │  │
│  │                       └───────────┼───────────────┘  │  │
│  └───────────────────────────────────┼──────────────────┘  │
└──────────────────────────────────────┼─────────────────────┘
                                       │ Chat Participant API
                          ┌────────────▼──────────────────┐
                          │  AI Agent Chat Participant      │
                          │  Extension（本方案实现）         │
                          │                                 │
                          │  - 注册为默认 Chat Participant  │
                          │  - Agent 进程生命周期管理        │
                          │  - 消息转发与流式响应            │
                          │  - 多 Agent 适配与切换          │
                          │  - Agent 自动安装               │
                          │  - 多用户多进程隔离              │
                          └────────────┬──────────────────┘
                                       │ HTTP + SSE
                          ┌────────────▼──────────────────┐
                          │  Agent 后端                      │
                          │  (opencode serve, root 运行)     │
                          │                                 │
                          │  - 对话引擎                      │
                          │  - 工具调用                      │
                          │  - MCP Client                   │
                          └────────────┬──────────────────┘
                                       │ HTTPS / 本地
                          ┌────────────▼──────────────────┐
                          │  LLM Provider                   │
                          │  (OpenAI / Anthropic / Ollama)  │
                          └────────────────────────────────┘
```

### 4.2 通信链路

| 链路 | 协议 | 说明 |
|---|---|---|
| Chat UI ↔ Chat Participant | VS Code Chat API（进程内） | VS Code 原生通信 |
| Chat Participant ↔ Agent | HTTP REST + SSE 流式 | 消息转发 |
| Agent ↔ 云端 LLM | HTTPS | 模型调用 |
| Agent ↔ 本地模型（Ollama） | HTTP | 本地模型调用 |
| Agent ↔ MCP Server | 本地进程 stdio | 工具调用 |

### 4.3 运行环境

- Agent 进程以 **root** 用户运行
- Agent 进程**无资源限制**（不设 CPU/内存 cgroup 限制）
- 每个用户 session 对应一个独立的 Agent 进程，监听独立端口

### 4.4 启动流程

```
code-server 启动
  │
  ├─ 读取 config.yaml → 获取默认 Agent 配置
  │
  ├─ 检查 ai-agent 扩展是否已安装
  │     └─ 未安装 → 从 lib/extensions/ai-agent.vsix 自动安装
  │
  ├─ VS Code Extension Host 激活 ai-agent
  │     ├─ 读取默认 Agent（ai.agent.defaultProvider）
  │     ├─ 检查 Agent CLI 是否已安装
  │     │     └─ 未安装且 autoInstall → 执行安装脚本
  │     ├─ 若 autoStart → spawn Agent 服务进程
  │     │     └─ 轮询健康检查 → 通过后标记就绪
  │     ├─ 注册为默认 Chat Participant
  │     │     └─ 用户打开面板直接对话，无需前缀
  │     └─ 注册配置项到 VS Code Settings
  │
  └─ 用户点击 Chat 图标 → 面板打开 → 直接输入 → 就绪
```

### 4.5 Agent 切换

用户在 VS Code Settings 中修改 `ai-agent.defaultProvider`，或通过命令面板 `>AI: Switch Agent` 切换：

1. 停止当前 Agent 进程
2. 若新 Agent CLI 未安装，自动安装
3. 启动新 Agent 进程（每个用户独立端口）
4. 更新默认 Chat Participant 的委托目标
5. 后续对话自动路由到新 Agent

临时切换到非默认 Agent：在 Chat 面板中输入 `@agent-name` 前缀即可。

## 5. 与 GitHub Codespaces 对标

| 维度 | GitHub Codespaces | 本方案 |
|---|---|---|
| 对话入口 | `Cmd+Shift+I`，直接输入 | `Cmd+Shift+I`，直接输入（相同） |
| Chat 基础设施 | VS Code Chat API | VS Code Chat API（相同） |
| 默认对话体验 | 打开面板即用 | 打开面板即用（相同） |
| AI 后端 | Copilot（固定） | OpenCode / Claude Code / Codex / Hermes（可切换） |
| 模型选择 | Copilot 内置模型 | 云端 API + 本地 Ollama 全覆盖 |
| MCP 工具链 | 不支持 | 原生 MCP Server 管理 |
| 数据流向 | GitHub 服务器 | 用户自控 |
| 定价模式 | 订阅制 | 按自有 API 用量付费 |
| 部署环境 | 仅 Codespaces | 任何运行 code-server 的机器 |
| Agent 安装 | 预装，无需用户操作 | 自动检测 + 自动安装脚本 |
| 多用户隔离 | — | 每人独立 Agent 进程 |
| 分发方式 | — | 扩展仅内置，不公开上架 |

**差异化核心**：同等 Chat UX 体验 + Agent 完全可替换 + 数据主权归属用户。

## 6. 实施计划

### Phase 1：OpenCode 适配（当前阶段）

**目标**：用户在 code-server 的 Chat 面板中直接输入即可与 OpenCode 对话。

**交付物：**

1. `ai-agent` VS Code 扩展
   - 注册为**默认 Chat Participant**（用户直接对话，无需前缀）
   - OpenCode CLI 自动检测 + `autoInstall` 安装脚本
   - 激活时自动 `spawn opencode serve`
   - 消息转发（HTTP POST → SSE 流式回包 → `stream.markdown()`）
   - 上下文注入（`#file`、`#selection` → 拼入 prompt）
   - 扩展停用时 kill OpenCode 进程
   - `contributes.configuration` 贡献设置项（含 Ollama 本地模型配置）
   - 多用户多进程隔离

2. code-server 集成
   - `config.yaml` 新增 `ai` 配置段
   - 新增 `--ai-agent` CLI 参数
   - 内置 `ai-agent.vsix` 到 `lib/extensions/`，仅内置分发
   - 启动时自动安装和启用扩展

3. 测试
   - 扩展单元测试（Agent 进程管理、消息转发、安装脚本）
   - E2E 测试（启动 code-server → 自动安装 OpenCode → Chat 面板可用 → 发送消息 → 收到回复）
   - 多用户场景：两 session 同时对话，Agent 进程隔离验证

**预计工作量**：5-7 个工作日

### Phase 2：多 Agent 支持 + MCP UI

- 实现 `AgentAdapter` 抽象层
- 适配 Claude Code、Codex、Hermes
- Agent 切换面板（VS Code 命令面板 `>AI: Switch Agent`）
- MCP Server Webview 管理界面

### Phase 3：深度集成

- 终端错误一键发送到 Chat
- 代码诊断信息作为上下文
- 自定义斜杠命令
- 对话历史导出与搜索

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as http from 'http';
import * as path from 'path';
import * as os from 'os';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class OpenCodeAdapter {
  private serverProcess: cp.ChildProcess | null = null;
  private context: vscode.ExtensionContext;
  private messageHistory: ChatMessage[] = [];

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /** Start the OpenCode server process */
  async startServer(): Promise<void> {
    const config = vscode.workspace.getConfiguration('ai-agent.opencode');
    const port = config.get<number>('port', 4096);

    // Kill any existing process on the port
    await this.stopServer();

    // Check if opencode CLI is available
    const opencodePath = this.findOpenCode();
    if (!opencodePath) {
      throw new Error(
        'OpenCode CLI not found. Please install it from https://opencode.ai'
      );
    }

    // Determine unique port per session
    const sessionPort = this.resolvePort(port);

    // Build environment with model configuration
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCODE_PORT: String(sessionPort),
    };

    const modelProvider = config.get<string>('model.provider', 'openai');
    const modelApiKey = config.get<string>('model.apiKey', '');
    const modelBaseUrl = config.get<string>('model.baseUrl', '');

    // Resolve environment variables in values
    if (modelApiKey) {
      const resolved = this.resolveEnvVar(modelApiKey);
      if (modelProvider === 'openai') {
        env.OPENAI_API_KEY = resolved;
      } else if (modelProvider === 'anthropic') {
        env.ANTHROPIC_API_KEY = resolved;
      }
    }
    if (modelBaseUrl) {
      env.OPENAI_BASE_URL = this.resolveEnvVar(modelBaseUrl);
    }

    const opencodeDir = path.join(os.homedir(), '.opencode');
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(opencodeDir));
    } catch {
      // Directory may already exist
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();

    // Start opencode serve
    this.serverProcess = cp.spawn(opencodePath, ['serve', '--port', String(sessionPort)], {
      env,
      cwd: workspaceRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.serverProcess.stdout?.on('data', (data: Buffer) => {
      console.log(`[opencode] ${data.toString().trim()}`);
    });

    this.serverProcess.stderr?.on('data', (data: Buffer) => {
      console.error(`[opencode:err] ${data.toString().trim()}`);
    });

    this.serverProcess.on('exit', (code) => {
      console.log(`[opencode] Process exited with code ${code}`);
      this.serverProcess = null;
    });

    // Wait for server to be ready
    await this.waitForServer(sessionPort, 15000);
  }

  /** Stop the OpenCode server process */
  async stopServer(): Promise<void> {
    if (this.serverProcess) {
      this.serverProcess.kill('SIGTERM');
      this.serverProcess = null;
      // Give it a moment to clean up
      await new Promise((r) => setTimeout(r, 500));
    }

    // Also clean up any orphan processes on the port
    const config = vscode.workspace.getConfiguration('ai-agent.opencode');
    const port = config.get<number>('port', 4096);
    try {
      cp.execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' });
    } catch {
      // Ignore errors
    }
  }

  /** Handle a chat request */
  async handleRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('ai-agent.opencode');
    const port = this.resolvePort(config.get<number>('port', 4096));

    // Build user message with context
    let userMessage = '';

    // Add file references as context
    for (const ref of request.references) {
      if (ref.id === 'vscode.file') {
        userMessage += `\n\n--- File: ${ref.name} ---\n`;
        userMessage += `${ref.value}\n`;
        userMessage += `--- End of ${ref.name} ---\n`;
      }
    }

    // Add selection context
    if (request.references.length === 0) {
      const editor = vscode.window.activeTextEditor;
      if (editor && !editor.selection.isEmpty) {
        const filePath = vscode.workspace.asRelativePath(editor.document.uri);
        userMessage += `\n\n--- Selected code from ${filePath} ---\n`;
        userMessage += editor.document.getText(editor.selection);
        userMessage += `\n--- End of selection ---\n`;
      }
    }

    userMessage += `\n\n${request.prompt}`;

    // Check for slash commands
    if (request.command === 'explain') {
      userMessage = `Explain the following code in detail:\n${userMessage}`;
    } else if (request.command === 'fix') {
      userMessage = `Find and fix issues in the following code:\n${userMessage}`;
    } else if (request.command === 'test') {
      userMessage = `Generate comprehensive tests for the following code:\n${userMessage}`;
    } else if (request.command === 'doc') {
      userMessage = `Generate documentation for the following code:\n${userMessage}`;
    }

    this.messageHistory.push({ role: 'user', content: userMessage });

    try {
      const response = await this.sendChatRequest(
        port, this.messageHistory, token, stream
      );
      this.messageHistory.push({ role: 'assistant', content: response });
    } catch (error) {
      stream.markdown(`**Error:** ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /** Send chat request to OpenCode server via HTTP */
  private async sendChatRequest(
    port: number,
    messages: ChatMessage[],
    token: vscode.CancellationToken,
    stream: vscode.ChatResponseStream
  ): Promise<string> {
    const config = vscode.workspace.getConfiguration('ai-agent.opencode');
    const model = config.get<string>('model.model', 'gpt-4o');
    const temperature = config.get<number>('model.temperature', 0.7);
    const maxTokens = config.get<number>('model.maxTokens', 4096);

    const requestBody = JSON.stringify({
      messages: messages.slice(-20), // Keep last 20 messages for context
      model,
      temperature,
      max_tokens: maxTokens,
      stream: true,
    });

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(requestBody).toString(),
          },
        },
        (res) => {
          let fullResponse = '';
          let buffer = '';

          res.on('data', (chunk: Buffer) => {
            if (token.isCancellationRequested) {
              res.destroy();
              resolve(fullResponse);
              return;
            }

            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;
                try {
                  const parsed = JSON.parse(data);
                  const content = parsed.choices?.[0]?.delta?.content;
                  if (content) {
                    fullResponse += content;
                    stream.markdown(fullResponse);
                  }
                } catch {
                  // Skip unparseable chunks
                }
              }
            }
          });

          res.on('end', () => {
            resolve(fullResponse);
          });

          res.on('error', reject);
        }
      );

      req.on('error', reject);
      req.write(requestBody);
      req.end();

      token.onCancellationRequested(() => {
        req.destroy();
        resolve(fullResponse || '');
      });
    });
  }

  /** Wait for the server to become healthy */
  private async waitForServer(port: number, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await this.healthCheck(port);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error(`OpenCode server did not become healthy within ${timeoutMs}ms`);
  }

  /** Check if the server is ready */
  private async healthCheck(port: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 2000 },
        (res) => resolve(res.statusCode === 200)
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
  }

  /** Find the opencode binary */
  private findOpenCode(): string | null {
    const searchPaths = [
      '/usr/local/bin/opencode',
      '/usr/bin/opencode',
      path.join(os.homedir(), '.bun/bin/opencode'),
      path.join(os.homedir(), '.local/bin/opencode'),
      '/opt/opencode/opencode',
    ];

    for (const p of searchPaths) {
      try {
        cp.execSync(`test -x "${p}"`, { stdio: 'ignore' });
        return p;
      } catch {
        continue;
      }
    }

    // Try which as fallback
    try {
      const result = cp.execSync('which opencode 2>/dev/null', { encoding: 'utf8' }).trim();
      if (result) return result;
    } catch {
      // Not found
    }

    return null;
  }

  /** Resolve environment variable references in a string */
  private resolveEnvVar(value: string): string {
    return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
  }

  /** Resolve port, adding session offset for multi-user isolation */
  private resolvePort(basePort: number): number {
    // For multi-user isolation, each session gets basePort + sessionIndex
    // Session index is derived from a simple hash of the process PID
    const sessionIndex = (process.pid || 0) % 100;
    return basePort + sessionIndex;
  }
}

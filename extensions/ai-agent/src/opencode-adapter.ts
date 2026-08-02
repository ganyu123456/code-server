import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export class OpenCodeAdapter {
  private currentProcess: cp.ChildProcess | null = null;

  isServerRunning(): boolean {
    return this.findOpenCode() !== null;
  }

  cancelRequest(): void {
    if (this.currentProcess) {
      this.currentProcess.kill('SIGTERM');
      this.currentProcess = null;
    }
  }

  async startServer(): Promise<void> {
    // Write opencode config with current model settings
    this.writeOpenCodeConfig();
  }

  async stopServer(): Promise<void> {
    this.cancelRequest();
  }

  async *streamChat(messages: ChatMessage[]): AsyncGenerator<string> {
    const config = vscode.workspace.getConfiguration('ai-agent.opencode');
    const provider = config.get<string>('model.provider', 'openai');
    const model = config.get<string>('model.model', 'gpt-4o');
    const apiKey = config.get<string>('model.apiKey', '');
    const baseUrl = config.get<string>('model.baseUrl', '');

    // Build opencode model reference: provider/model-name
    const opencodeModel = model.includes('/') ? model : `${provider}/${model}`;

    // Get the last user message
    const lastMsg = messages.filter(m => m.role === 'user').pop();
    if (!lastMsg) return;

    const opencodePath = this.findOpenCode();
    if (!opencodePath) throw new Error('OpenCode CLI not found');

    // Write config before running
    this.writeOpenCodeConfig();

    let allOutput = '';
    let completed = false;
    let lastYieldLen = 0;

    const proc = cp.spawn(opencodePath, ['run', '--model', opencodeModel, lastMsg.content], {
      env: {
        ...(process.env as Record<string, string>),
        ...(apiKey ? { OPENAI_API_KEY: this.resolveEnvVar(apiKey) } : {}),
        ...(baseUrl ? { OPENAI_BASE_URL: this.resolveEnvVar(baseUrl) } : {}),
        HOME: os.homedir(),
      },
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.currentProcess = proc;

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      // Strip ANSI escape codes and status lines
      const cleaned = text
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
      const lines = cleaned.split('\n').filter(
        l => l.trim() && !l.startsWith('>') && !l.startsWith('timestamp=')
      );
      if (lines.length > 0) {
        allOutput += lines.join('\n') + '\n';
      }
    });

    proc.on('close', (code) => {
      if (code !== 0 && allOutput.length === 0) {
        completed = true;
      } else {
        completed = true;
      }
    });

    proc.on('error', () => {
      completed = true;
    });

    try {
      while (!completed || allOutput.length > lastYieldLen) {
        if (allOutput.length > lastYieldLen) {
          const newContent = allOutput.substring(lastYieldLen);
          lastYieldLen = allOutput.length;
          yield newContent;
        }
        if (!completed) {
          await new Promise(r => setTimeout(r, 50));
        }
      }
    } finally {
      this.currentProcess = null;
      if (!completed) {
        proc.kill('SIGTERM');
      }
    }
  }

  private writeOpenCodeConfig(): void {
    const config = vscode.workspace.getConfiguration('ai-agent.opencode');
    const provider = config.get<string>('model.provider', 'openai');
    const model = config.get<string>('model.model', 'gpt-4o');
    const apiKey = config.get<string>('model.apiKey', '');
    const baseUrl = config.get<string>('model.baseUrl', '');

    const resolvedKey = this.resolveEnvVar(apiKey) || process.env.OPENAI_API_KEY || '';
    const resolvedUrl = this.resolveEnvVar(baseUrl) || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

    // Build opencode config for custom provider
    const opencodeConfig: any = {
      $schema: 'https://opencode.ai/config.json',
    };

    // Only add custom provider if a non-default config is needed
    if (provider !== 'openai' || resolvedUrl !== 'https://api.openai.com/v1') {
      opencodeConfig.provider = {
        [provider]: {
          npm: '@ai-sdk/openai-compatible',
          name: provider.charAt(0).toUpperCase() + provider.slice(1),
          options: {
            baseURL: resolvedUrl.replace(/\/+$/, ''),
          },
          models: {
            [model]: { name: model },
          },
        },
      };
      if (resolvedKey) {
        opencodeConfig.provider[provider].options.apiKey = resolvedKey;
      }
      opencodeConfig.model = `${provider}/${model}`;
    }

    const configDir = path.join(os.homedir(), '.config', 'opencode');
    const configPath = path.join(configDir, 'opencode.jsonc');

    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(opencodeConfig, null, 2));
    } catch {
      // Non-critical: config may already exist or be unreadable
      console.log('[opencode] Could not write config to', configPath);
    }
  }

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
        cp.execSync(`test -f "${p}"`, { stdio: 'ignore' });
        return p;
      } catch { /* continue */ }
    }
    try {
      return cp.execSync('which opencode 2>/dev/null', { encoding: 'utf8' }).trim() || null;
    } catch {
      return null;
    }
  }

  private resolveEnvVar(value: string): string {
    return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
  }
}

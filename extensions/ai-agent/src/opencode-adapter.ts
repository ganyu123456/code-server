import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export class OpenCodeAdapter {
  private currentRequest: http.ClientRequest | null = null;

  isServerRunning(): boolean {
    return true;
  }

  cancelRequest(): void {
    if (this.currentRequest) {
      this.currentRequest.destroy();
      this.currentRequest = null;
    }
  }

  async startServer(): Promise<void> {
    // No-op: direct API mode doesn't need a server process
  }

  async stopServer(): Promise<void> {
    // No-op
  }

  async *streamChat(messages: ChatMessage[]): AsyncGenerator<string> {
    const config = vscode.workspace.getConfiguration('ai-agent.opencode');
    const provider = config.get<string>('model.provider', 'openai');
    const model = config.get<string>('model.model', 'gpt-4o');
    const temperature = config.get<number>('model.temperature', 0.7);
    const maxTokens = config.get<number>('model.maxTokens', 4096);

    let apiKey = config.get<string>('model.apiKey', '');
    let baseUrl = config.get<string>('model.baseUrl', '');

    // Resolve env vars and fall back to process.env
    apiKey = this.resolveEnvVar(apiKey) || process.env.OPENAI_API_KEY || '';
    baseUrl = this.resolveEnvVar(baseUrl) || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

    if (!apiKey) throw new Error('API Key not configured. Set ai-agent.opencode.model.apiKey in Settings.');

    // Ensure base URL ends without /v1
    const apiBase = baseUrl.replace(/\/+$/, '');
    const apiPath = '/v1/chat/completions';

    const requestBody = JSON.stringify({
      messages: messages.slice(-20),
      model,
      temperature,
      max_tokens: maxTokens,
      stream: true,
    });

    const chunks: string[] = [];
    let requestDone = false;
    let requestError: Error | null = null;

    const url = new URL(apiPath, apiBase);
    const isHttps = url.protocol === 'https:';

    const transport = isHttps ? https : http;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(requestBody).toString(),
        },
      },
      (res: any) => {
        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;
              try {
                const content = JSON.parse(data).choices?.[0]?.delta?.content;
                if (content) chunks.push(content);
              } catch { /* skip malformed SSE */ }
            }
          }
        });
        res.on('end', () => { requestDone = true; });
        res.on('error', (e: Error) => { requestError = e; requestDone = true; });
      }
    );

    req.on('error', (e: Error) => { requestError = e; requestDone = true; });
    this.currentRequest = req;
    req.write(requestBody);
    req.end();

    try {
      while (!requestDone || chunks.length > 0) {
        if (chunks.length > 0) {
          yield chunks.shift()!;
        } else if (!requestDone) {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      if (requestError) throw requestError;
    } finally {
      this.currentRequest = null;
    }
  }

  private resolveEnvVar(value: string): string {
    return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
  }
}

import * as vscode from 'vscode';
import { OpenCodeAdapter } from './opencode-adapter';

let adapter: OpenCodeAdapter | undefined;

class ChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(private readonly _context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._context.extensionUri, 'media'),
      ],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'chat':
          await this._handleChat(msg.message);
          break;
        case 'cancel':
          adapter?.cancelRequest();
          break;
        case 'info':
          this._sendStatus();
          break;
      }
    });

    this._sendStatus();
  }

  private async _handleChat(message: string) {
    if (!adapter) {
      this._postMessage({ type: 'error', message: 'AI Agent is not initialized.' });
      return;
    }
    if (!adapter.isServerRunning()) {
      this._postMessage({ type: 'error', message: 'Agent server is not running. Try "AI: Restart Agent".' });
      return;
    }

    this._postMessage({ type: 'thinking', thinking: true });

    try {
      const opencodeMsgs = [{ role: 'user' as const, content: message }];
      let accumulated = '';
      for await (const chunk of adapter.streamChat(opencodeMsgs)) {
        accumulated += chunk;
        this._postMessage({ type: 'response', content: accumulated, partial: true });
      }
      this._postMessage({ type: 'response', content: accumulated, partial: false });
      this._postMessage({ type: 'thinking', thinking: false });
    } catch (e: any) {
      this._postMessage({ type: 'error', message: e.message || String(e) });
      this._postMessage({ type: 'thinking', thinking: false });
    }
  }

  private _sendStatus() {
    const running = adapter?.isServerRunning() ?? false;
    const config = vscode.workspace.getConfiguration('ai-agent.opencode.model');
    this._postMessage({
      type: 'status',
      serverRunning: running,
      model: config.get<string>('model', 'gpt-4o'),
      provider: config.get<string>('provider', 'openai'),
    });
  }

  private _postMessage(msg: any) {
    this._view?.webview.postMessage(msg);
  }

  postStatus() {
    this._sendStatus();
  }

  postError(message: string) {
    this._postMessage({ type: 'error', message });
  }

  private _getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'chat.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'chat.css')
    );

    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <link href="${styleUri}" rel="stylesheet">
</head>
<body>
  <div id="chat-container">
    <div id="status-bar">
      <span id="status-indicator" class="status-offline"></span>
      <span id="status-text">Offline</span>
      <span id="model-info"></span>
    </div>
    <div id="messages"></div>
    <div id="input-area">
      <textarea id="chat-input" placeholder="Ask AI Agent... (Shift+Enter for newline)" rows="2"></textarea>
      <button id="send-btn" title="Send (Enter)">Send</button>
      <button id="cancel-btn" title="Cancel" style="display:none">Stop</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 64; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export async function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('ai-agent');
  const provider = config.get<string>('defaultProvider', 'opencode');

  if (provider !== 'opencode') {
    vscode.window.showInformationMessage(
      `AI Agent: '${provider}' is not yet supported. Using OpenCode.`
    );
  }

  // Initialize adapter
  adapter = new OpenCodeAdapter();
  const providerInstance = new ChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ai-agent.chatView', providerInstance)
  );

  // Open AI Agent sidebar by default and hide native Chat panel
  setTimeout(async () => {
    try {
      await vscode.commands.executeCommand('ai-agent.chatView.focus');
      await vscode.commands.executeCommand('workbench.action.chat.hide');
    } catch { /* commands may not be available yet, retry once */ }
  }, 1000);

  // Start OpenCode server if auto-start is enabled
  const autoStart = config.get<boolean>('opencode.autoStart', true);
  if (autoStart) {
    try {
      await adapter.startServer();
      providerInstance.postStatus();
    } catch (error) {
      vscode.window.showWarningMessage(`Failed to start OpenCode server: ${error}`);
    }
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('ai-agent.focusChatView', () => {
      vscode.commands.executeCommand('ai-agent.chatView.focus');
    }),
    vscode.commands.registerCommand('ai-agent.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:opencode.ai-agent');
    }),
    vscode.commands.registerCommand('ai-agent.switchAgent', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'OpenCode', description: 'Default AI agent (current)', picked: true },
          { label: 'Claude Code', description: 'Phase 2' },
          { label: 'Codex', description: 'Phase 2' },
          { label: 'Hermes', description: 'Phase 2' },
        ],
        { placeHolder: 'Select AI Agent' }
      );
      if (pick?.label === 'OpenCode' && adapter) {
        await config.update('defaultProvider', 'opencode', vscode.ConfigurationTarget.Global);
        await adapter.startServer();
        providerInstance.postStatus();
      }
    }),
    vscode.commands.registerCommand('ai-agent.restartAgent', async () => {
      if (adapter) {
        await adapter.stopServer();
        await adapter.startServer();
        providerInstance.postStatus();
        vscode.window.showInformationMessage('AI Agent restarted');
      }
    })
  );
}

export async function deactivate() {
  if (adapter) {
    await adapter.stopServer();
  }
}

import * as vscode from 'vscode';
import { OpenCodeAdapter } from './opencode-adapter';

let adapter: OpenCodeAdapter | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('ai-agent');
  const provider = config.get<string>('defaultProvider', 'opencode');

  if (provider !== 'opencode') {
    vscode.window.showInformationMessage(
      `AI Agent: '${provider}' is not yet supported. Only OpenCode is available in this version.`
    );
  }

  adapter = new OpenCodeAdapter(context);

  // Register as default chat participant (no @ prefix needed)
  const participant = vscode.chat.createChatParticipant(
    'ai-agent',
    async (request, chatContext, stream, token) => {
      if (!adapter) {
        stream.markdown('**AI Agent is not initialized.** Please restart code-server.');
        return;
      }
      await adapter.handleRequest(request, chatContext, stream, token);
    }
  );

  participant.iconPath = new vscode.ThemeIcon('robot');

  // Start OpenCode server if auto-start is enabled
  const autoStart = config.get<boolean>('opencode.autoStart', true);
  if (autoStart) {
    try {
      await adapter.startServer();
    } catch (error) {
      vscode.window.showWarningMessage(`Failed to start OpenCode server: ${error}`);
    }
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('ai-agent.switchAgent', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'OpenCode', description: 'Default AI agent (current)', picked: true },
          { label: 'Claude Code', description: 'Coming in Phase 2' },
          { label: 'Codex', description: 'Coming in Phase 2' },
          { label: 'Hermes', description: 'Coming in Phase 2' },
        ],
        { placeHolder: 'Select AI Agent' }
      );
      if (pick?.label === 'OpenCode') {
        await config.update('defaultProvider', 'opencode', vscode.ConfigurationTarget.Global);
        if (adapter) {
          await adapter.startServer();
        }
      }
    }),

    vscode.commands.registerCommand('ai-agent.restartAgent', async () => {
      if (adapter) {
        await adapter.stopServer();
        await adapter.startServer();
        vscode.window.showInformationMessage('AI Agent restarted');
      }
    })
  );

  context.subscriptions.push(participant);
}

export async function deactivate() {
  if (adapter) {
    await adapter.stopServer();
  }
}

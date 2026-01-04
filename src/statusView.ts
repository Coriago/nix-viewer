import * as vscode from 'vscode';
import { StatusUpdate } from './flakeTreeProvider';

/**
 * Webview provider for displaying status messages.
 * Shows errors and info without disrupting the tree view.
 */
export class StatusViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'flakeStatus';

    private view?: vscode.WebviewView;
    private statusHistory: StatusUpdate[] = [];
    private maxHistory = 50;

    constructor(private readonly extensionUri: vscode.Uri) { }

    /**
     * Called when the webview is created.
     */
    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };

        webviewView.webview.html = this.getHtmlContent();

        // Restore status history when webview is created
        this.restoreStatusHistory();

        // Restore status history when webview becomes visible again
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.restoreStatusHistory();
            }
        });
    }

    /**
     * Restore the status history to the webview.
     */
    private restoreStatusHistory(): void {
        if (this.view && this.statusHistory.length > 0) {
            this.view.webview.postMessage({
                type: 'status',
                updates: this.statusHistory.slice(0, 10),
            });
        }
    }

    /**
     * Update the status display.
     */
    updateStatus(update: StatusUpdate): void {
        this.statusHistory.unshift(update);

        // Trim history
        if (this.statusHistory.length > this.maxHistory) {
            this.statusHistory = this.statusHistory.slice(0, this.maxHistory);
        }

        if (this.view) {
            this.view.webview.postMessage({
                type: 'status',
                updates: this.statusHistory.slice(0, 10),
            });
        }
    }

    /**
     * Clear all status messages.
     */
    clear(): void {
        this.statusHistory = [];
        if (this.view) {
            this.view.webview.postMessage({ type: 'clear' });
        }
    }

    /**
     * Generate the HTML content for the webview.
     */
    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 8px;
      margin: 0;
    }
    .status-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .status-item {
      padding: 4px 8px;
      margin: 2px 0;
      border-radius: 3px;
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }
    .status-icon {
      flex-shrink: 0;
      width: 16px;
      text-align: center;
    }
    .status-message {
      flex: 1;
      word-break: break-word;
    }
    .status-time {
      flex-shrink: 0;
      font-size: 0.85em;
      opacity: 0.7;
    }
    .status-info {
      background: var(--vscode-inputValidation-infoBackground);
      border-left: 3px solid var(--vscode-inputValidation-infoBorder);
    }
    .status-error {
      background: var(--vscode-inputValidation-errorBackground);
      border-left: 3px solid var(--vscode-inputValidation-errorBorder);
    }
    .status-success {
      background: rgba(0, 128, 0, 0.1);
      border-left: 3px solid var(--vscode-terminal-ansiGreen);
    }
    .empty-state {
      text-align: center;
      opacity: 0.7;
      padding: 20px;
    }
  </style>
</head>
<body>
  <ul class="status-list" id="statusList">
    <li class="empty-state">No status updates yet</li>
  </ul>
  <script>
    const vscode = acquireVsCodeApi();
    const statusList = document.getElementById('statusList');

    const icons = {
      info: '$(info)',
      error: '$(error)',
      success: '$(check)'
    };

    const iconSymbols = {
      info: 'ℹ️',
      error: '❌',
      success: '✓'
    };

    function formatTime(timestamp) {
      const date = new Date(timestamp);
      return date.toLocaleTimeString();
    }

    function renderStatus(updates) {
      if (!updates || updates.length === 0) {
        statusList.innerHTML = '<li class="empty-state">No status updates yet</li>';
        return;
      }

      statusList.innerHTML = updates.map(update => \`
        <li class="status-item status-\${update.type}">
          <span class="status-icon">\${iconSymbols[update.type] || '•'}</span>
          <span class="status-message">\${escapeHtml(update.message)}</span>
          <span class="status-time">\${formatTime(update.timestamp)}</span>
        </li>
      \`).join('');
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'status':
          renderStatus(message.updates);
          break;
        case 'clear':
          renderStatus([]);
          break;
      }
    });
  </script>
</body>
</html>`;
    }
}

import * as vscode from 'vscode';
import * as path from 'path';
import { FlakeTreeProvider } from './flakeTreeProvider';
import { FlakeNode, FlakeNodeType } from './flakeNode';
import { NixRunner } from './nixRunner';
import { StatusViewProvider } from './statusView';

let outputChannel: vscode.OutputChannel;
let nixRunner: NixRunner;
let treeProvider: FlakeTreeProvider;
let statusProvider: StatusViewProvider;
let fileWatcher: vscode.FileSystemWatcher | undefined;
let debounceTimer: NodeJS.Timeout | undefined;

/**
 * Extension activation.
 */
export function activate(context: vscode.ExtensionContext): void {
    outputChannel = vscode.window.createOutputChannel('Nix Flake Explorer');
    context.subscriptions.push(outputChannel);
    outputChannel.show(); // Show output panel on activation
    outputChannel.appendLine('=== Nix Flake Explorer Activating ===');

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        outputChannel.appendLine('ERROR: No workspace folder found');
        vscode.window.showErrorMessage('Nix Flake Explorer: No workspace folder found');
        return;
    }
    outputChannel.appendLine(`Workspace root: ${workspaceRoot}`);

    // Check for flake.nix
    const flakePath = path.join(workspaceRoot, 'flake.nix');
    outputChannel.appendLine(`Looking for flake at: ${flakePath}`);

    // Initialize components
    nixRunner = new NixRunner(outputChannel);
    treeProvider = new FlakeTreeProvider(workspaceRoot, nixRunner);
    statusProvider = new StatusViewProvider(context.extensionUri);

    // Connect status updates
    treeProvider.onStatusUpdate((update) => {
        statusProvider.updateStatus(update);
    });

    // Register tree view
    const treeView = vscode.window.createTreeView('flakeOutputsTree', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    // Register status webview
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            StatusViewProvider.viewType,
            statusProvider
        )
    );

    // Register commands
    registerCommands(context, treeView);

    // Set up file watching
    setupFileWatcher(context, workspaceRoot);

    outputChannel.appendLine(`Nix Flake Explorer activated for: ${workspaceRoot}`);
}

/**
 * Get the workspace root folder.
 */
function getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return undefined;
    }
    return folders[0].uri.fsPath;
}

/**
 * Register extension commands.
 */
function registerCommands(
    context: vscode.ExtensionContext,
    treeView: vscode.TreeView<FlakeNode>
): void {
    // Refresh command
    context.subscriptions.push(
        vscode.commands.registerCommand('flakeExplorer.refresh', () => {
            treeProvider.refresh();
        })
    );

    // Open value command
    context.subscriptions.push(
        vscode.commands.registerCommand('flakeExplorer.openValue', async (node?: FlakeNode) => {
            const targetNode = node || treeView.selection[0];
            if (!targetNode) {
                vscode.window.showWarningMessage('No node selected');
                return;
            }

            await openNodeValue(targetNode);
        })
    );

    // Copy path command
    context.subscriptions.push(
        vscode.commands.registerCommand('flakeExplorer.copyPath', async (node?: FlakeNode) => {
            const targetNode = node || treeView.selection[0];
            if (!targetNode) {
                vscode.window.showWarningMessage('No node selected');
                return;
            }

            const attrPath = targetNode.attrPath;
            await vscode.env.clipboard.writeText(attrPath);
            vscode.window.showInformationMessage(`Copied: ${attrPath}`);
        })
    );

    // Set root path command
    context.subscriptions.push(
        vscode.commands.registerCommand('flakeExplorer.setRootPath', async () => {
            const config = vscode.workspace.getConfiguration('nixFlakeExplorer');
            const currentRoot = config.get<string>('rootPath', '');

            const newRoot = await vscode.window.showInputBox({
                prompt: 'Enter the attribute path to use as root (leave empty for all outputs)',
                value: currentRoot,
                placeHolder: 'e.g., nixosConfigurations.myhost.config',
            });

            if (newRoot !== undefined) {
                await config.update('rootPath', newRoot, vscode.ConfigurationTarget.Workspace);
                treeProvider.refresh();
            }
        })
    );
}

/**
 * Open a node's value in a new editor.
 */
async function openNodeValue(node: FlakeNode): Promise<void> {
    const progressOptions: vscode.ProgressOptions = {
        location: vscode.ProgressLocation.Notification,
        title: 'Loading value...',
        cancellable: true,
    };

    await vscode.window.withProgress(progressOptions, async (progress, token) => {
        try {
            let value: unknown;
            let title: string;

            if (node.nodeType === FlakeNodeType.Derivation) {
                progress.report({ message: 'Fetching derivation info...' });
                value = await treeProvider.getDerivationInfo(node);
                title = `${node.label} (derivation)`;
            } else {
                progress.report({ message: 'Evaluating value...' });
                value = await treeProvider.getNodeValue(node);
                title = node.attrPath || 'Flake Value';
            }

            if (token.isCancellationRequested) {
                return;
            }

            // Format JSON with indentation
            const content = JSON.stringify(value, null, 2);

            // Create a new untitled document
            const doc = await vscode.workspace.openTextDocument({
                content,
                language: 'json',
            });

            await vscode.window.showTextDocument(doc, {
                preview: true,
                viewColumn: vscode.ViewColumn.Beside,
            });

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to load value: ${message}`);
        }
    });
}

/**
 * Set up file watching for auto-refresh.
 */
function setupFileWatcher(
    context: vscode.ExtensionContext,
    workspaceRoot: string
): void {
    const config = vscode.workspace.getConfiguration('nixFlakeExplorer');
    const patterns = config.get<string[]>('watchPatterns', [
        'flake.nix',
        'flake.lock',
        '**/*.nix',
    ]);
    const debounceMs = config.get<number>('debounceMs', 500);

    // Create a combined pattern
    const pattern = patterns.length === 1
        ? patterns[0]
        : `{${patterns.join(',')}}`;

    fileWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceRoot, pattern)
    );

    const triggerRefresh = () => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            outputChannel.appendLine('File change detected, refreshing...');
            treeProvider.refresh();
        }, debounceMs);
    };

    fileWatcher.onDidChange(triggerRefresh);
    fileWatcher.onDidCreate(triggerRefresh);
    fileWatcher.onDidDelete(triggerRefresh);

    context.subscriptions.push(fileWatcher);

    // Also watch for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('nixFlakeExplorer')) {
                outputChannel.appendLine('Configuration changed, refreshing...');
                treeProvider.refresh();
            }
        })
    );
}

/**
 * Extension deactivation.
 */
export function deactivate(): void {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    nixRunner?.cancelAll();
    outputChannel?.appendLine('Nix Flake Explorer deactivated');
}

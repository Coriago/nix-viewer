import * as vscode from 'vscode';
import { logger } from './logger';

/**
 * Response from nixd option completion.
 */
export interface OptionField {
    Name: string;
    Description?: {
        Description?: string;
        Type?: {
            Name?: string;
            Description?: string;
        };
    };
}

/**
 * Response from nixd attrpath completion.
 */
export type AttrPathCompleteResponse = string[];

/**
 * Client for communicating with a running nixd LSP server.
 * 
 * This uses VS Code's language model to request completions from nixd
 * by simulating completion requests at specific positions in Nix files.
 */
export class NixdClient {
    private static instance: NixdClient | null = null;
    private initPromise: Promise<boolean> | null = null;
    private available: boolean = false;

    private constructor() {}

    /**
     * Get the singleton instance.
     */
    static getInstance(): NixdClient {
        if (!NixdClient.instance) {
            NixdClient.instance = new NixdClient();
        }
        return NixdClient.instance;
    }

    /**
     * Initialize and check if nixd is available.
     */
    async initialize(): Promise<boolean> {
        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = this.doInitialize();
        return this.initPromise;
    }

    private async doInitialize(): Promise<boolean> {
        try {
            // Check for Nix language extensions
            const nixExtensions = [
                'jnoortheen.nix-ide',
                'bbenoist.nix',
            ];

            for (const extId of nixExtensions) {
                const ext = vscode.extensions.getExtension(extId);
                if (ext) {
                    logger.log(`Found Nix extension: ${extId}`);
                    if (!ext.isActive) {
                        await ext.activate();
                    }
                    this.available = true;
                    return true;
                }
            }

            logger.log('No Nix extension found');
            this.available = false;
            return false;

        } catch (error) {
            logger.error('Failed to initialize nixd client', error);
            this.available = false;
            return false;
        }
    }

    /**
     * Check if nixd is available.
     */
    async isAvailable(): Promise<boolean> {
        await this.initialize();
        return this.available;
    }

    /**
     * Get completion suggestions by triggering LSP completion on a virtual Nix expression.
     * 
     * This creates a temporary completion context that nixd can respond to.
     * 
     * @param optionPath - The option path to complete (e.g., "programs.gi")
     * @returns Array of completion suggestions
     */
    async getOptionCompletion(scope: string[], prefix: string): Promise<OptionField[]> {
        // For now, return empty - we'll implement the virtual document approach
        // or find another way to communicate with nixd
        return [];
    }

    /**
     * Get attribute path completion from nixd.
     */
    async getAttrPathCompletion(scope: string[], prefix: string): Promise<string[]> {
        // For now, return empty
        return [];
    }

    /**
     * Get completion suggestions for a NixOS config path using VS Code's completion API.
     * 
     * This works by:
     * 1. Finding an open .nix file or creating a virtual one
     * 2. Constructing a completion position for the given path
     * 3. Requesting completions from the LSP at that position
     * 
     * @param configPath - Full config path like "nixosConfigurations.myhost.config"
     * @param relativePath - The path being typed, relative to config (e.g., "programs.gi")
     * @returns Array of completion suggestions
     */
    async getConfigCompletion(
        configPath: string,
        relativePath: string
    ): Promise<string[]> {
        try {
            await this.initialize();
            
            if (!this.available) {
                return [];
            }

            // Find an open Nix document to use for completion context
            const nixDoc = vscode.workspace.textDocuments.find(
                doc => doc.languageId === 'nix'
            );

            if (!nixDoc) {
                logger.log('No Nix document open for completion context');
                return [];
            }

            // Parse the path to determine completion position
            const { scope, prefix } = parsePathForCompletion(relativePath);
            
            // Build the attribute path expression that nixd would recognize
            // For options, we need something like: config.programs.git
            const fullPath = scope.length > 0 
                ? `${scope.join('.')}.${prefix}`
                : prefix;

            // Try to find a suitable position in the document for completion
            // We look for patterns like "config." or option assignments
            const text = nixDoc.getText();
            const configPatterns = [
                /config\.[\w.]*$/m,
                /\{\s*[\w.]+\s*=.*?$/m,
            ];

            let position: vscode.Position | null = null;

            // Find a position in the document where we can request completion
            for (const pattern of configPatterns) {
                const match = pattern.exec(text);
                if (match) {
                    const offset = match.index + match[0].length;
                    position = nixDoc.positionAt(offset);
                    break;
                }
            }

            if (!position) {
                // Use end of first line as fallback
                position = new vscode.Position(0, text.indexOf('\n') || 0);
            }

            // Request completions from the language server
            const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
                'vscode.executeCompletionItemProvider',
                nixDoc.uri,
                position,
                '.' // Trigger character
            );

            if (!completions || !completions.items) {
                return [];
            }

            // Filter completions that match our prefix
            const prefixLower = prefix.toLowerCase();
            const results: string[] = [];

            for (const item of completions.items) {
                const label = typeof item.label === 'string' 
                    ? item.label 
                    : item.label.label;
                
                if (!prefix || label.toLowerCase().startsWith(prefixLower)) {
                    const fullPath = scope.length > 0
                        ? `${scope.join('.')}.${label}`
                        : label;
                    results.push(fullPath);
                }
            }

            logger.log(`nixd completion returned ${results.length} items for "${relativePath}"`);
            return results.slice(0, 50);

        } catch (error) {
            logger.error('Config completion failed', error);
            return [];
        }
    }

    /**
     * Dispose of resources.
     */
    dispose(): void {
        NixdClient.instance = null;
    }
}

/**
 * Attribute info result from batched query.
 */
export interface AttrInfo {
    type: string;
    isDrv: boolean;
    attrNames?: string[];
    listLength?: number;
    value?: unknown;
}

/**
 * Helper to parse a dot-separated path into scope and prefix.
 */
export function parsePathForCompletion(path: string): { scope: string[]; prefix: string } {
    if (!path) {
        return { scope: [], prefix: '' };
    }

    const parts = path.split('.');
    
    // If path ends with '.', we want all children of the full path
    if (path.endsWith('.')) {
        return { scope: parts.slice(0, -1), prefix: '' };
    }

    // Otherwise, the last part is the prefix we're completing
    const prefix = parts.pop() || '';
    return { scope: parts, prefix };
}

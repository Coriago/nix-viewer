import { FlakeTreeProvider } from './flakeTreeProvider';
import { SearchViewProvider } from './searchView';
import { NixdClient, parsePathForCompletion } from './nixdClient';
import { logger } from './logger';

/**
 * Provides search/filter functionality for the flake tree view.
 * Connects the search webview to the tree provider.
 * 
 * Uses nixd LSP for fast autocomplete when available, with local
 * path tree as fallback.
 * 
 * Paths are stored and displayed relative to the configured root path.
 * For example, if rootPath is "nixosConfigurations.myhost.config",
 * then "programs.git" is stored instead of the full path.
 */
export class SearchProvider {
    private treeProvider: FlakeTreeProvider;
    private searchView: SearchViewProvider;
    private nixdClient: NixdClient;
    
    /** All known relative paths (relative to root) */
    private allPaths: Set<string> = new Set();
    
    /** Path tree for autocomplete: parent -> children (all relative) */
    private pathTree: Map<string, Set<string>> = new Map();

    /** Whether nixd is available for completions */
    private nixdAvailable: boolean | null = null;

    /** Debounce timer for nixd requests */
    private nixdDebounceTimer: NodeJS.Timeout | null = null;

    /** Pending nixd completion request */
    private pendingNixdRequest: AbortController | null = null;

    constructor(treeProvider: FlakeTreeProvider, searchView: SearchViewProvider) {
        this.treeProvider = treeProvider;
        this.searchView = searchView;
        this.nixdClient = NixdClient.getInstance();

        // Listen for search changes from the webview
        this.searchView.onDidChangeSearch((value) => {
            this.handleSearchChange(value);
        });

        // Check nixd availability in background
        this.checkNixdAvailability();
    }

    /**
     * Check if nixd is available for completions.
     */
    private async checkNixdAvailability(): Promise<void> {
        try {
            this.nixdAvailable = await this.nixdClient.isAvailable();
            logger.log(`nixd availability: ${this.nixdAvailable}`);
        } catch (error) {
            logger.error('Error checking nixd availability', error);
            this.nixdAvailable = false;
        }
    }

    /**
     * Get the configured root path.
     */
    private getRootPath(): string {
        return this.treeProvider.getConfiguredRootPath();
    }

    /**
     * Convert an absolute path to a relative path (relative to root).
     */
    private toRelativePath(absolutePath: string): string {
        const rootPath = this.getRootPath();
        if (!rootPath) {
            return absolutePath;
        }
        
        // If the path starts with the root path, strip it
        if (absolutePath.startsWith(rootPath + '.')) {
            return absolutePath.slice(rootPath.length + 1);
        }
        
        // If the path equals the root path, return empty
        if (absolutePath === rootPath) {
            return '';
        }
        
        // Path doesn't start with root - return as-is (shouldn't happen normally)
        return absolutePath;
    }

    /**
     * Handle search input changes.
     */
    private handleSearchChange(query: string): void {
        // Update the filter on the tree provider (using relative path)
        this.treeProvider.setFilterPath(query);

        // Cancel any pending nixd request
        if (this.pendingNixdRequest) {
            this.pendingNixdRequest.abort();
            this.pendingNixdRequest = null;
        }

        // Clear debounce timer
        if (this.nixdDebounceTimer) {
            clearTimeout(this.nixdDebounceTimer);
            this.nixdDebounceTimer = null;
        }

        // Get immediate suggestions from local cache (fast)
        const localSuggestions = this.getLocalAutocompleteSuggestions(query);
        this.searchView.updateSuggestions(localSuggestions);

        // If nixd is available, also fetch from nixd with debounce (may be slower but more complete)
        if (this.nixdAvailable && query) {
            this.nixdDebounceTimer = setTimeout(() => {
                this.fetchNixdSuggestions(query, localSuggestions);
            }, 150); // 150ms debounce for nixd requests
        }
    }

    /**
     * Fetch suggestions from nixd and merge with local results.
     */
    private async fetchNixdSuggestions(query: string, localSuggestions: string[]): Promise<void> {
        const abortController = new AbortController();
        this.pendingNixdRequest = abortController;

        try {
            const configPath = this.getRootPath();
            const nixdResults = await this.nixdClient.getConfigCompletion(configPath, query);

            // Check if request was aborted
            if (abortController.signal.aborted) {
                return;
            }

            if (nixdResults.length > 0) {
                // Merge nixd results with local results, preferring nixd
                const merged = this.mergeSuggestions(nixdResults, localSuggestions);
                this.searchView.updateSuggestions(merged);
                logger.log(`Updated suggestions with ${nixdResults.length} nixd results`);
            }
        } catch (error) {
            if (!abortController.signal.aborted) {
                logger.error('Error fetching nixd suggestions', error);
            }
        } finally {
            if (this.pendingNixdRequest === abortController) {
                this.pendingNixdRequest = null;
            }
        }
    }

    /**
     * Merge nixd suggestions with local suggestions, removing duplicates.
     */
    private mergeSuggestions(nixdSuggestions: string[], localSuggestions: string[]): string[] {
        const seen = new Set<string>();
        const result: string[] = [];

        // Add nixd suggestions first (they're more authoritative)
        for (const s of nixdSuggestions) {
            if (!seen.has(s)) {
                seen.add(s);
                result.push(s);
            }
        }

        // Add local suggestions that aren't already present
        for (const s of localSuggestions) {
            if (!seen.has(s)) {
                seen.add(s);
                result.push(s);
            }
        }

        return result.slice(0, 30);
    }

    /**
     * Index a path for search.
     * The path should be absolute - we convert it to relative internally.
     */
    indexPath(absolutePath: string): void {
        if (!absolutePath) return;
        
        const relativePath = this.toRelativePath(absolutePath);
        if (!relativePath) return; // Don't index the root itself
        
        this.allPaths.add(relativePath);
        
        // Build path tree for autocomplete
        const parts = this.splitPath(relativePath);
        let current = '';
        
        for (let i = 0; i < parts.length; i++) {
            const parent = current;
            current = current ? `${current}.${parts[i]}` : parts[i];
            
            if (!this.pathTree.has(parent)) {
                this.pathTree.set(parent, new Set());
            }
            this.pathTree.get(parent)!.add(current);
        }
    }

    /**
     * Split a path into parts, handling bracket notation.
     */
    private splitPath(path: string): string[] {
        // Split on dots, but preserve bracket notation
        const parts: string[] = [];
        let current = '';
        let inBracket = false;
        
        for (const char of path) {
            if (char === '[') {
                inBracket = true;
                current += char;
            } else if (char === ']') {
                inBracket = false;
                current += char;
            } else if (char === '.' && !inBracket) {
                if (current) {
                    parts.push(current);
                    current = '';
                }
            } else {
                current += char;
            }
        }
        
        if (current) {
            parts.push(current);
        }
        
        return parts;
    }

    /**
     * Clear all indexed paths.
     */
    clearIndex(): void {
        this.allPaths.clear();
        this.pathTree.clear();
    }

    /**
     * Get autocomplete suggestions from local path tree (fast, cached).
     */
    private getLocalAutocompleteSuggestions(query: string): string[] {
        if (!query) {
            // Show top-level relative paths when empty
            const topLevel = this.pathTree.get('');
            return topLevel ? Array.from(topLevel).sort().slice(0, 20) : [];
        }

        const normalizedQuery = query.toLowerCase();
        const suggestions: { path: string; score: number }[] = [];
        
        // If query ends with '.', show children of that path
        if (query.endsWith('.')) {
            const parentPath = query.slice(0, -1);
            const children = this.pathTree.get(parentPath);
            
            if (children) {
                return Array.from(children).sort().slice(0, 30);
            }
            return [];
        }
        
        // Find the parent path (everything before the last dot)
        const lastDotIndex = query.lastIndexOf('.');
        const parentPath = lastDotIndex > 0 ? query.slice(0, lastDotIndex) : '';
        const searchTerm = lastDotIndex > 0 ? query.slice(lastDotIndex + 1).toLowerCase() : normalizedQuery;
        
        // First, show children of the parent that match the search term
        const parentChildren = this.pathTree.get(parentPath);
        if (parentChildren) {
            for (const childPath of parentChildren) {
                const childName = childPath.split('.').pop()?.toLowerCase() || '';
                if (childName.startsWith(searchTerm)) {
                    suggestions.push({ path: childPath, score: 10 });
                } else if (childName.includes(searchTerm)) {
                    suggestions.push({ path: childPath, score: 5 });
                }
            }
        }
        
        // Also search all paths for fuzzy matches
        for (const path of this.allPaths) {
            const pathLower = path.toLowerCase();
            const lastPart = path.split('.').pop()?.toLowerCase() || '';
            
            // Skip if already added
            if (suggestions.find(s => s.path === path)) continue;
            
            if (lastPart.startsWith(searchTerm)) {
                suggestions.push({ path, score: 3 });
            } else if (pathLower.includes(normalizedQuery)) {
                suggestions.push({ path, score: 2 });
            } else if (this.fuzzyMatch(normalizedQuery, lastPart)) {
                suggestions.push({ path, score: 1 });
            }
        }
        
        // Sort by score, then alphabetically
        suggestions.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.path.localeCompare(b.path);
        });
        
        return suggestions.slice(0, 30).map(s => s.path);
    }

    /**
     * Simple fuzzy matching.
     */
    private fuzzyMatch(query: string, target: string): boolean {
        let queryIndex = 0;
        
        for (const char of target) {
            if (char === query[queryIndex]) {
                queryIndex++;
                if (queryIndex >= query.length) {
                    return true;
                }
            }
        }
        
        return false;
    }

    /**
     * Focus the search input.
     */
    focus(): void {
        this.searchView.focus();
    }

    /**
     * Clear the search.
     */
    clear(): void {
        this.searchView.clear();
    }

    /**
     * Dispose resources.
     */
    dispose(): void {
        if (this.nixdDebounceTimer) {
            clearTimeout(this.nixdDebounceTimer);
        }
        if (this.pendingNixdRequest) {
            this.pendingNixdRequest.abort();
        }
        this.clearIndex();
    }
}

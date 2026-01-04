import { FlakeTreeProvider } from './flakeTreeProvider';
import { SearchViewProvider } from './searchView';
import { logger } from './logger';

/**
 * Provides search/filter functionality for the flake tree view.
 * Connects the search webview to the tree provider.
 * 
 * Paths are stored and displayed relative to the configured root path.
 * For example, if rootPath is "nixosConfigurations.myhost.config",
 * then "programs.git" is stored instead of the full path.
 */
export class SearchProvider {
    private treeProvider: FlakeTreeProvider;
    private searchView: SearchViewProvider;
    
    /** All known relative paths (relative to root) */
    private allPaths: Set<string> = new Set();
    
    /** Path tree for autocomplete: parent -> children (all relative) */
    private pathTree: Map<string, Set<string>> = new Map();

    constructor(treeProvider: FlakeTreeProvider, searchView: SearchViewProvider) {
        this.treeProvider = treeProvider;
        this.searchView = searchView;

        // Listen for search changes from the webview
        this.searchView.onDidChangeSearch((value) => {
            this.handleSearchChange(value);
        });
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

        // Update autocomplete suggestions
        const suggestions = this.getAutocompleteSuggestions(query);
        this.searchView.updateSuggestions(suggestions);
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
     * Get autocomplete suggestions for a query (all paths are relative).
     */
    private getAutocompleteSuggestions(query: string): string[] {
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
        this.clearIndex();
    }
}

import * as vscode from 'vscode';
import * as os from 'os';
import { FlakeNode, FlakeNodeType, createLoadingNode, createErrorNode } from './flakeNode';
import { NixRunner } from './nixRunner';
import { logger } from './logger';

/**
 * Event emitter for status updates.
 */
export interface StatusUpdate {
    type: 'info' | 'error' | 'success';
    message: string;
    timestamp: Date;
}

/**
 * Tree data provider for flake outputs.
 */
export class FlakeTreeProvider implements vscode.TreeDataProvider<FlakeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<FlakeNode | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _onStatusUpdate = new vscode.EventEmitter<StatusUpdate>();
    readonly onStatusUpdate = this._onStatusUpdate.event;

    /** Event emitter for when paths are indexed (for search) */
    private _onPathIndexed = new vscode.EventEmitter<string>();
    readonly onPathIndexed = this._onPathIndexed.event;

    /** Event emitter for filter changes */
    private _onFilterChanged = new vscode.EventEmitter<string>();
    readonly onFilterChanged = this._onFilterChanged.event;

    private rootNode?: FlakeNode;
    private flakePath: string;
    private nixRunner: NixRunner;

    /** Last known good state for error resilience */
    private lastGoodChildren = new Map<string, FlakeNode[]>();

    /** Resolved hostname for path substitution */
    private hostname?: string;

    /** Resolved username for path substitution */
    private username?: string;

    /** Prefetch cache for common paths */
    private prefetchCache = new Map<string, FlakeNode[]>();
    private prefetchInProgress = false;

    /** Current filter path (for search) */
    private filterPath: string = '';

    /** All known attribute paths for search indexing */
    private knownPaths = new Set<string>();

    constructor(
        flakePath: string,
        nixRunner: NixRunner
    ) {
        this.flakePath = flakePath;
        this.nixRunner = nixRunner;
        // Resolve system info synchronously at construction time
        this.hostname = os.hostname();
        this.username = os.userInfo().username;
        logger.log(`Resolved hostname: ${this.hostname}, user: ${this.username}`);
    }

    /**
     * Update the flake path (workspace root).
     */
    setFlakePath(path: string): void {
        this.flakePath = path;
        this.refresh();
    }

    /**
     * Set the filter path for search.
     * When set, only shows nodes matching or containing this path.
     */
    setFilterPath(path: string): void {
        this.filterPath = path.trim();
        logger.log(`Filter path set to: "${this.filterPath}"`);
        this._onDidChangeTreeData.fire(undefined);
        
        if (this.filterPath) {
            this.emitStatus('info', `Filtered to: ${this.filterPath}`);
        } else {
            this.emitStatus('info', 'Filter cleared');
        }
        
        this._onFilterChanged.fire(this.filterPath);
    }

    /**
     * Get the current filter path.
     */
    getFilterPath(): string {
        return this.filterPath;
    }

    /**
     * Clear the search filter.
     */
    clearFilter(): void {
        this.setFilterPath('');
    }

    /**
     * Get all known paths for search indexing.
     */
    getKnownPaths(): Set<string> {
        return this.knownPaths;
    }

    /**
     * Index a path for search functionality.
     */
    private indexPath(attrPath: string): void {
        if (attrPath && !this.knownPaths.has(attrPath)) {
            this.knownPaths.add(attrPath);
            this._onPathIndexed.fire(attrPath);
        }
    }

    /**
     * Get the configured root path.
     */
    private getRootPath(): string {
        const configValue = vscode.workspace.getConfiguration('nixFlakeExplorer').get<string>('rootPath', 'nixosConfigurations.${hostname}.config');
        
        // Replace ${hostname} and ${user} placeholders
        return configValue
            .replace(/\$\{hostname\}/g, this.hostname || '')
            .replace(/\$\{user\}/g, this.username || '');
    }

    /**
     * Get the configured root path (public accessor for search).
     */
    getConfiguredRootPath(): string {
        return this.getRootPath();
    }

    /**
     * Get the list of paths to prefetch.
     */
    private getPrefetchPaths(): string[] {
        return vscode.workspace.getConfiguration('nixFlakeExplorer').get<string[]>('prefetchPaths', [
            'programs',
            'services',
            'environment',
            'system',
            'users',
            'nix',
            'networking',
            'boot',
            'hardware',
            'security'
        ]);
    }

    /**
     * Prefetch common config paths in the background.
     */
    async prefetchCommonPaths(): Promise<void> {
        if (this.prefetchInProgress) {
            return;
        }

        const rootPath = this.getRootPath();
        if (!rootPath) {
            return;  // Don't prefetch if not using a config root
        }

        this.prefetchInProgress = true;
        const pathsToPrefetch = this.getPrefetchPaths();

        logger.log(`Starting prefetch for ${pathsToPrefetch.length} common paths...`);
        this.emitStatus('info', 'Prefetching common config paths...');

        // Prefetch all paths in parallel
        const prefetchPromises = pathsToPrefetch.map(async (subPath) => {
            const fullPath = `${rootPath}.${subPath}`;
            try {
                const result = await this.nixRunner.getAttrNames(this.flakePath, fullPath);
                if (result.success) {
                    const attrNames = result.data as string[];
                    const children: FlakeNode[] = attrNames.sort().map(name => {
                        const childPath = `${fullPath}.${name}`;
                        const child = new FlakeNode(
                            name,
                            childPath,
                            FlakeNodeType.Attrset,
                            vscode.TreeItemCollapsibleState.Collapsed
                        );
                        // Index path for search
                        this.indexPath(childPath);
                        return child;
                    });
                    this.prefetchCache.set(fullPath, children);
                    this.lastGoodChildren.set(fullPath, children);
                    // Also index the parent path
                    this.indexPath(fullPath);
                    logger.log(`✓ Prefetched ${children.length} attrs for: ${subPath}`);
                }
            } catch (error) {
                logger.error(`Prefetch failed for ${fullPath}`, error);
            }
        });

        await Promise.all(prefetchPromises);
        this.prefetchInProgress = false;
        logger.log('Prefetch complete');
        this.emitStatus('success', 'Prefetch complete');
    }

    /**
     * Refresh the entire tree.
     */
    refresh(): void {
        this.rootNode = undefined;
        this.prefetchCache.clear();
        this.knownPaths.clear();
        this._onDidChangeTreeData.fire(undefined);
        this.emitStatus('info', 'Refreshing flake outputs...');
        // Restart prefetching in background
        this.prefetchCommonPaths();
    }

    /**
     * Refresh a specific node.
     */
    refreshNode(node: FlakeNode): void {
        node.cache = undefined;
        this._onDidChangeTreeData.fire(node);
    }

    /**
     * Emit a status update.
     */
    private emitStatus(type: StatusUpdate['type'], message: string): void {
        this._onStatusUpdate.fire({ type, message, timestamp: new Date() });
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
        
        // Path doesn't start with root - return as-is
        return absolutePath;
    }

    /**
     * Apply filter to children nodes.
     * Filter path is relative to the configured root path.
     * Shows nodes that:
     * - Match the filter path exactly
     * - Are ancestors of the filter path (path leads to filter)
     * - Are descendants of the filter path (path starts with filter)
     * - Have labels that fuzzy-match the filter
     */
    private applyFilter(children: FlakeNode[]): FlakeNode[] {
        if (!this.filterPath) {
            return children;
        }

        const filterLower = this.filterPath.toLowerCase();
        
        return children.filter(child => {
            // Convert child's absolute path to relative for comparison
            const childRelativePath = this.toRelativePath(child.attrPath);
            const childPathLower = childRelativePath.toLowerCase();
            const childLabelLower = (child.label as string)?.toLowerCase() || '';
            
            // Exact match
            if (childPathLower === filterLower) {
                return true;
            }
            
            // Child is ancestor of filter (filter path starts with child path)
            // e.g., child="programs", filter="programs.git"
            if (filterLower.startsWith(childPathLower + '.')) {
                return true;
            }
            
            // Child is descendant of filter (child path starts with filter path)
            // e.g., child="programs.git.enable", filter="programs.git"
            if (childPathLower.startsWith(filterLower + '.') || childPathLower.startsWith(filterLower)) {
                return true;
            }
            
            // Label fuzzy match for simple searches
            if (childLabelLower.includes(filterLower) || filterLower.includes(childLabelLower)) {
                return true;
            }
            
            return false;
        });
    }

    /**
     * Get tree item for display.
     */
    getTreeItem(element: FlakeNode): vscode.TreeItem {
        return element;
    }

    /**
     * Get children of a node.
     */
    async getChildren(element?: FlakeNode): Promise<FlakeNode[]> {
        if (!this.flakePath) {
            return [];
        }

        try {
            if (!element) {
                // Root level
                const children = await this.getRootChildren();
                return this.applyFilter(children);
            }

            // Check cache first
            const cached = element.getCachedChildren();
            if (cached) {
                return this.applyFilter(cached);
            }

            // Fetch children based on node type
            const children = await this.fetchChildren(element);

            // Index paths for search
            for (const child of children) {
                this.indexPath(child.attrPath);
            }

            // Cache for resilience
            if (children.length > 0 && element.nodeType !== FlakeNodeType.Error) {
                element.cacheChildren(children);
                this.lastGoodChildren.set(element.attrPath, children);
            }

            return this.applyFilter(children);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.emitStatus('error', `Failed to get children: ${message}`);

            // Return last known good state if available
            const lastGood = element ? this.lastGoodChildren.get(element.attrPath) : undefined;
            if (lastGood) {
                return lastGood;
            }

            return [createErrorNode(message, element)];
        }
    }

    /**
     * Get root-level children.
     */
    private async getRootChildren(): Promise<FlakeNode[]> {
        const rootPath = this.getRootPath();

        if (!rootPath) {
            // Show top-level flake outputs
            return this.fetchTopLevelOutputs();
        }

        // Create a synthetic root for the configured path
        this.rootNode = new FlakeNode(
            rootPath.split('.').pop() || 'root',
            rootPath,
            FlakeNodeType.Attrset,
            vscode.TreeItemCollapsibleState.Expanded
        );

        // Fetch children of the configured root path
        return this.fetchChildren(this.rootNode);
    }

    /**
     * Fetch top-level flake outputs using `nix flake show`.
     */
    private async fetchTopLevelOutputs(): Promise<FlakeNode[]> {
        const result = await this.nixRunner.flakeShow(this.flakePath);

        if (!result.success) {
            this.emitStatus('error', result.error || 'Failed to show flake');
            const lastGood = this.lastGoodChildren.get('');
            if (lastGood) {
                return lastGood;
            }
            return [createErrorNode(result.error || 'Failed to evaluate flake')];
        }

        this.emitStatus('success', 'Flake outputs loaded');

        const outputs = result.data as Record<string, unknown>;
        const children: FlakeNode[] = [];

        for (const key of Object.keys(outputs).sort()) {
            const node = new FlakeNode(
                key,
                key,
                FlakeNodeType.Attrset,
                vscode.TreeItemCollapsibleState.Collapsed
            );
            // Index path for search
            this.indexPath(key);
            children.push(node);
        }

        this.lastGoodChildren.set('', children);
        return children;
    }

    /**
     * Fetch children for a specific node.
     */
    private async fetchChildren(parent: FlakeNode): Promise<FlakeNode[]> {
        // First, determine the type of the parent value
        const typeResult = await this.nixRunner.getValueType(this.flakePath, parent.attrPath);

        if (!typeResult.success) {
            this.emitStatus('error', typeResult.error || 'Failed to get type');
            const lastGood = this.lastGoodChildren.get(parent.attrPath);
            if (lastGood) {
                return lastGood;
            }
            return [createErrorNode(typeResult.error || 'Failed to evaluate', parent)];
        }

        const valueType = typeResult.data as string;

        switch (valueType) {
            case 'set':
                return this.fetchAttrsetChildren(parent);
            case 'list':
                return this.fetchListChildren(parent);
            default:
                // It's a leaf value, fetch and display it
                parent.nodeType = FlakeNodeType.Leaf;
                parent.collapsibleState = vscode.TreeItemCollapsibleState.None;
                await this.fetchLeafValue(parent);
                return [];
        }
    }

    /**
     * Fetch children of an attribute set.
     */
    private async fetchAttrsetChildren(parent: FlakeNode): Promise<FlakeNode[]> {
        // Check prefetch cache first
        const prefetched = this.prefetchCache.get(parent.attrPath);
        if (prefetched) {
            logger.log(`Using prefetch cache for: ${parent.attrPath}`);
            // Set parent reference on cached children
            prefetched.forEach(child => child.parent = parent);
            return prefetched;
        }

        // Check if it's a derivation first
        const drvCheck = await this.nixRunner.isDerivation(this.flakePath, parent.attrPath);

        if (drvCheck.success && drvCheck.data === true) {
            parent.nodeType = FlakeNodeType.Derivation;
            parent.updateAppearance();
            // For derivations, we can still show their attributes
        }

        const result = await this.nixRunner.getAttrNames(this.flakePath, parent.attrPath);

        if (!result.success) {
            this.emitStatus('error', result.error || 'Failed to get attributes');
            const lastGood = this.lastGoodChildren.get(parent.attrPath);
            if (lastGood) {
                return lastGood;
            }
            return [createErrorNode(result.error || 'Failed to evaluate', parent)];
        }

        const attrNames = result.data as string[];
        const children: FlakeNode[] = [];

        for (const name of attrNames.sort()) {
            const child = parent.createChild(name, FlakeNodeType.Attrset);
            children.push(child);
        }

        this.emitStatus('success', `Loaded ${children.length} attributes`);
        return children;
    }

    /**
     * Fetch children of a list (e.g., home.packages).
     */
    private async fetchListChildren(parent: FlakeNode): Promise<FlakeNode[]> {
        parent.nodeType = FlakeNodeType.List;
        parent.updateAppearance();

        // Fetch all list elements info in a single nix eval call (much faster)
        logger.log(`Fetching list children for: ${parent.attrPath}`);
        const elementsResult = await this.nixRunner.getListElementsInfo(this.flakePath, parent.attrPath);

        if (!elementsResult.success) {
            logger.error(`Failed to get list elements for ${parent.attrPath}: ${elementsResult.error}`);
            this.emitStatus('error', elementsResult.error || 'Failed to get list elements');
            const lastGood = this.lastGoodChildren.get(parent.attrPath);
            if (lastGood) {
                return lastGood;
            }
            return [createErrorNode(elementsResult.error || 'Failed to evaluate', parent)];
        }

        const elements = elementsResult.data as Array<{ index: number; name: string; isDrv: boolean }>;
        const children: FlakeNode[] = [];

        for (const elem of elements) {
            const child = new FlakeNode(
                elem.name,
                `${parent.attrPath}.[${elem.index}]`,  // Use bracket notation for list access
                elem.isDrv ? FlakeNodeType.Derivation : FlakeNodeType.ListElement,
                // Derivations in lists are typically packages - don't make them expandable
                elem.isDrv ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed
            );
            child.listIndex = elem.index;
            child.parent = parent;
            child.updateAppearance();
            // Override for derivations to not be expandable
            if (elem.isDrv) {
                child.collapsibleState = vscode.TreeItemCollapsibleState.None;
            }
            children.push(child);
        }

        logger.log(`✓ Loaded ${children.length} list items for: ${parent.attrPath}`);
        this.emitStatus('success', `Loaded ${children.length} list items`);
        return children;
    }

    /**
     * Create a node for a list element.
     */
    private async fetchListElementNode(parent: FlakeNode, index: number): Promise<FlakeNode> {
        const infoResult = await this.nixRunner.getListElementInfo(
            this.flakePath,
            parent.attrPath,
            index
        );

        if (infoResult.success && infoResult.data) {
            const info = infoResult.data as { name: string; isDrv: boolean };
            const node = new FlakeNode(
                info.name,
                `${parent.attrPath}`,
                info.isDrv ? FlakeNodeType.Derivation : FlakeNodeType.ListElement,
                vscode.TreeItemCollapsibleState.Collapsed
            );
            node.parent = parent;
            node.listIndex = index;
            node.tooltip = `${parent.attrPath}[${index}] - ${info.name}`;
            return node;
        }

        // Fallback to index-based name
        const node = new FlakeNode(
            `[${index}]`,
            `${parent.attrPath}`,
            FlakeNodeType.ListElement,
            vscode.TreeItemCollapsibleState.Collapsed
        );
        node.parent = parent;
        node.listIndex = index;
        return node;
    }

    /**
     * Fetch and display a leaf value.
     */
    private async fetchLeafValue(node: FlakeNode): Promise<void> {
        const result = await this.nixRunner.getValue(this.flakePath, node.attrPath);

        if (result.success) {
            node.setValue(result.data);
            node.cache = { value: result.data, timestamp: Date.now() };
        } else {
            node.setError(result.error || 'Failed to evaluate');
        }
    }

    /**
     * Get the full value of a node for display.
     */
    async getNodeValue(node: FlakeNode): Promise<unknown> {
        // For list elements, we need special handling
        if (node.listIndex !== undefined && node.parent) {
            const result = await this.nixRunner.run(
                [
                    'eval', '--json',
                    `.#${node.parent.attrPath}`,
                    '--apply', `xs: builtins.elemAt xs ${node.listIndex}`
                ],
                { cwd: this.flakePath }
            );
            return result.success ? result.data : { error: result.error };
        }

        const result = await this.nixRunner.getValue(this.flakePath, node.attrPath);
        return result.success ? result.data : { error: result.error };
    }

    /**
     * Get derivation JSON for a node.
     */
    async getDerivationInfo(node: FlakeNode): Promise<unknown> {
        // Get the drvPath
        let drvPathResult;

        if (node.listIndex !== undefined && node.parent) {
            drvPathResult = await this.nixRunner.run(
                [
                    'eval', '--raw',
                    `.#${node.parent.attrPath}`,
                    '--apply', `xs: (builtins.elemAt xs ${node.listIndex}).drvPath`
                ],
                { cwd: this.flakePath }
            );
        } else {
            drvPathResult = await this.nixRunner.getDrvPath(this.flakePath, node.attrPath);
        }

        if (!drvPathResult.success) {
            return { error: drvPathResult.error };
        }

        const drvPath = drvPathResult.data as string;
        const drvResult = await this.nixRunner.getDerivationJson(this.flakePath, drvPath);

        return drvResult.success ? drvResult.data : { error: drvResult.error };
    }

    /**
     * Get parent for tree view.
     */
    getParent(element: FlakeNode): FlakeNode | undefined {
        return element.parent;
    }
}

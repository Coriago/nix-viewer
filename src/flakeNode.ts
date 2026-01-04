import * as vscode from 'vscode';

/**
 * Types of nodes in the flake tree.
 */
export enum FlakeNodeType {
    /** An attribute set that can be expanded */
    Attrset = 'attrset',
    /** A list that can be expanded */
    List = 'list',
    /** A list element (may be derivation or other) */
    ListElement = 'listElement',
    /** A derivation (package) */
    Derivation = 'derivation',
    /** A primitive leaf value (string, number, bool, null) */
    Leaf = 'leaf',
    /** A value that couldn't be evaluated */
    Error = 'error',
    /** Loading placeholder */
    Loading = 'loading',
}

/**
 * Cached data for a node.
 */
export interface FlakeNodeCache {
    children?: FlakeNode[];
    value?: unknown;
    timestamp: number;
}

/**
 * Represents a node in the flake outputs tree.
 */
export class FlakeNode extends vscode.TreeItem {
    /** Full attribute path from flake root */
    public readonly attrPath: string;

    /** Type of this node */
    public nodeType: FlakeNodeType;

    /** Index if this is a list element */
    public listIndex?: number;

    /** Cached children and value */
    public cache?: FlakeNodeCache;

    /** Parent node (if any) */
    public parent?: FlakeNode;

    /** Error message if evaluation failed */
    public errorMessage?: string;

    constructor(
        label: string,
        attrPath: string,
        nodeType: FlakeNodeType,
        collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        super(label, collapsibleState);
        this.attrPath = attrPath;
        this.nodeType = nodeType;
        this.contextValue = nodeType;
        this.updateAppearance();
    }

    /**
     * Update the visual appearance based on node type.
     */
    updateAppearance(): void {
        switch (this.nodeType) {
            case FlakeNodeType.Attrset:
                this.iconPath = new vscode.ThemeIcon('symbol-namespace');
                this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                break;
            case FlakeNodeType.List:
                this.iconPath = new vscode.ThemeIcon('symbol-array');
                this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                break;
            case FlakeNodeType.ListElement:
                this.iconPath = new vscode.ThemeIcon('symbol-variable');
                this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                break;
            case FlakeNodeType.Derivation:
                this.iconPath = new vscode.ThemeIcon('package');
                this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                break;
            case FlakeNodeType.Leaf:
                this.iconPath = new vscode.ThemeIcon('symbol-constant');
                this.collapsibleState = vscode.TreeItemCollapsibleState.None;
                break;
            case FlakeNodeType.Error:
                this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
                this.collapsibleState = vscode.TreeItemCollapsibleState.None;
                break;
            case FlakeNodeType.Loading:
                this.iconPath = new vscode.ThemeIcon('loading~spin');
                this.collapsibleState = vscode.TreeItemCollapsibleState.None;
                break;
        }

        // Set tooltip to full attr path
        this.tooltip = this.attrPath || '(flake root)';
    }

    /**
     * Set the displayed value for leaf nodes.
     */
    setValue(value: unknown): void {
        if (value === undefined) {
            this.description = undefined;
            return;
        }

        // Format value for display
        if (typeof value === 'string') {
            const truncated = value.length > 50 ? value.slice(0, 47) + '...' : value;
            this.description = `"${truncated}"`;
        } else if (typeof value === 'boolean' || typeof value === 'number') {
            this.description = String(value);
        } else if (value === null) {
            this.description = 'null';
        } else if (Array.isArray(value)) {
            this.description = `[${value.length} items]`;
        } else if (typeof value === 'object') {
            const keys = Object.keys(value as object);
            this.description = `{ ${keys.length} attrs }`;
        } else {
            this.description = String(value);
        }
    }

    /**
     * Mark this node as having an error.
     */
    setError(message: string): void {
        this.errorMessage = message;
        this.nodeType = FlakeNodeType.Error;
        this.description = 'error';
        this.tooltip = message;
        this.updateAppearance();
    }

    /**
     * Create a child node.
     */
    createChild(
        name: string,
        nodeType: FlakeNodeType,
        listIndex?: number
    ): FlakeNode {
        const childPath = this.attrPath
            ? (listIndex !== undefined ? `${this.attrPath}` : `${this.attrPath}.${name}`)
            : name;

        const child = new FlakeNode(
            name,
            childPath,
            nodeType,
            nodeType === FlakeNodeType.Leaf ?
                vscode.TreeItemCollapsibleState.None :
                vscode.TreeItemCollapsibleState.Collapsed
        );

        child.parent = this;
        child.listIndex = listIndex;

        return child;
    }

    /**
     * Get cached children if available and not expired.
     */
    getCachedChildren(maxAgeMs = 60000): FlakeNode[] | undefined {
        if (!this.cache?.children) {
            return undefined;
        }

        const age = Date.now() - this.cache.timestamp;
        if (age > maxAgeMs) {
            return undefined;
        }

        return this.cache.children;
    }

    /**
     * Cache children for this node.
     */
    cacheChildren(children: FlakeNode[]): void {
        this.cache = {
            ...this.cache,
            children,
            timestamp: Date.now(),
        };
    }

    /**
     * Get the flake reference for nix commands.
     */
    getFlakeRef(): string {
        return this.attrPath ? `.#${this.attrPath}` : '.';
    }
}

/**
 * Create a loading placeholder node.
 */
export function createLoadingNode(parent?: FlakeNode): FlakeNode {
    const node = new FlakeNode(
        'Loading...',
        parent?.attrPath ?? '',
        FlakeNodeType.Loading,
        vscode.TreeItemCollapsibleState.None
    );
    node.parent = parent;
    return node;
}

/**
 * Create an error node.
 */
export function createErrorNode(message: string, parent?: FlakeNode): FlakeNode {
    const node = new FlakeNode(
        'Error',
        parent?.attrPath ?? '',
        FlakeNodeType.Error,
        vscode.TreeItemCollapsibleState.None
    );
    node.setError(message);
    node.parent = parent;
    return node;
}

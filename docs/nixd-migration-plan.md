# Migration Plan: nixd-Powered Tree Provider

## Overview of Changes

The goal is to:
1. **Remove prefetch** - Eliminate background nix eval calls
2. **Use nixd for data** - Get attr names, types, and values via LSP
3. **Smart caching** - Only cache currently-visible (expanded) nodes
4. **Targeted refresh** - On file change, refresh deepest-open nodes first, clear caches for collapsed nodes

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       FlakeTreeProvider                          │
│  - Tracks expanded nodes (Set<attrPath>)                        │
│  - Manages node cache (Map<attrPath, NodeMetadata>)             │
│  - Orchestrates refresh on file changes                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         NixdClient                               │
│  - getAttrInfo(path) → {type, isDrv, attrNames?, value?}        │
│  - getCompletion(scope, prefix) → string[]                      │
│  - Uses vscode.executeCompletionItemProvider                    │
│  - Falls back to NixRunner if nixd unavailable                  │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│   nixd LSP (primary)    │     │  NixRunner (fallback)   │
│  - Fast completions     │     │  - Direct nix eval      │
│  - Cached evaluations   │     │  - Slower but reliable  │
└─────────────────────────┘     └─────────────────────────┘
```

## Key Data Structures

```typescript
// Enhanced node metadata cache
interface NodeMetadata {
    type: 'set' | 'list' | 'derivation' | 'leaf';
    isDrv: boolean;
    attrNames?: string[];      // For sets
    listLength?: number;       // For lists  
    value?: unknown;           // For leaves
    timestamp: number;
}

// Track UI state
interface TreeState {
    expandedPaths: Set<string>;     // Currently expanded in UI
    nodeCache: Map<string, NodeMetadata>;
}
```

## Refresh Strategy on File Change

```typescript
// 1. Get all expanded paths
// 2. Sort by depth (deepest first): programs.vscode.enable > programs.vscode > programs
// 3. For each expanded path:
//    - Re-fetch metadata from nixd
//    - Update tree if changed
// 4. Clear cache for all NON-expanded paths (they'll be re-fetched on expand)
```

## Implementation Steps

### Step 1: Enhance NixdClient
- Add `getAttrInfo(path)` method that returns type, isDrv, attrNames in one call
- Add `getListInfo(path)` for list-specific metadata
- Implement proper fallback to NixRunner when nixd unavailable

### Step 2: Update FlakeNode
- Add `metadata: NodeMetadata` field
- Track whether node is currently expanded
- Simplify cache structure

### Step 3: Refactor FlakeTreeProvider
- Remove:
  - `prefetchCache: Map<string, FlakeNode[]>`
  - `prefetchInProgress: boolean`
  - `prefetchCommonPaths()` method
  - `getPrefetchPaths()` method
  - References to prefetch in `refresh()`
  
- Add:
  - `expandedPaths: Set<string>` - Track which nodes are expanded
  - `metadataCache: Map<string, NodeMetadata>` - Cache node metadata
  - `onDidExpand(path)` / `onDidCollapse(path)` - Handle expand/collapse events
  - `smartRefresh()` - Refresh only expanded nodes, deepest first

### Step 4: Update extension.ts
- Hook into `treeView.onDidExpandElement` and `treeView.onDidCollapseElement`
- Pass events to FlakeTreeProvider
- Update file watcher to use smart refresh

## Detailed Changes

### FlakeTreeProvider Changes

```typescript
// REMOVE these fields:
private prefetchCache = new Map<string, FlakeNode[]>();
private prefetchInProgress = false;

// ADD these fields:
private expandedPaths = new Set<string>();
private metadataCache = new Map<string, NodeMetadata>();

// MODIFY refresh():
refresh(): void {
    this.rootNode = undefined;
    // Don't clear metadataCache entirely - smartRefresh will handle it
    this.knownPaths.clear();
    this._onDidChangeTreeData.fire(undefined);
    this.emitStatus('info', 'Refreshing flake outputs...');
    // NO prefetching - data fetched on demand
}

// ADD smartRefresh():
async smartRefresh(): Promise<void> {
    // Sort expanded paths by depth (deepest first)
    const sortedPaths = [...this.expandedPaths].sort((a, b) => {
        const depthA = a.split('.').length;
        const depthB = b.split('.').length;
        return depthB - depthA; // Deepest first
    });
    
    // Clear cache for non-expanded paths
    for (const path of this.metadataCache.keys()) {
        if (!this.expandedPaths.has(path)) {
            this.metadataCache.delete(path);
        }
    }
    
    // Refresh expanded paths
    for (const path of sortedPaths) {
        this.metadataCache.delete(path);
        // Fire change event to trigger re-fetch
        const node = this.findNodeByPath(path);
        if (node) {
            this._onDidChangeTreeData.fire(node);
        }
    }
}

// ADD expand/collapse handlers:
onNodeExpanded(path: string): void {
    this.expandedPaths.add(path);
    logger.log(`Node expanded: ${path}`);
}

onNodeCollapsed(path: string): void {
    this.expandedPaths.delete(path);
    // Clear cache for this path and all descendants
    for (const cachedPath of this.metadataCache.keys()) {
        if (cachedPath === path || cachedPath.startsWith(path + '.')) {
            this.metadataCache.delete(cachedPath);
        }
    }
    logger.log(`Node collapsed: ${path}, cache cleared`);
}
```

### extension.ts Changes

```typescript
// After creating treeView, add event handlers:
treeView.onDidExpandElement((e) => {
    treeProvider.onNodeExpanded(e.element.attrPath);
});

treeView.onDidCollapseElement((e) => {
    treeProvider.onNodeCollapsed(e.element.attrPath);
});

// In file watcher handler, use smartRefresh:
fileWatcher.onDidChange(() => {
    treeProvider.smartRefresh();
});
```

## Testing Checklist

- [ ] Initial tree load works without prefetch
- [ ] Expanding nodes fetches data correctly
- [ ] Collapsing nodes clears cache
- [ ] File changes refresh only expanded nodes
- [ ] Deep nodes refresh before shallow ones
- [ ] Autocomplete still works via nixd
- [ ] Fallback to nix eval works when nixd unavailable
- [ ] No memory leaks from cache growth

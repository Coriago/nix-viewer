# Copilot Instructions for Nix Flake Explorer

## Project Overview
VS Code extension that browses Nix flake outputs in a tree view. Activates when `flake.nix` is present in workspace.

## Architecture (6 core files in `src/`)

| File | Role |
|------|------|
| `extension.ts` | Entry point - exports `activate(context)` / `deactivate()`, registers commands/views, sets up file watcher |
| `flakeTreeProvider.ts` | `FlakeTreeProvider implements vscode.TreeDataProvider<FlakeNode>` - tree state, caching, fetches children |
| `flakeNode.ts` | `FlakeNode extends vscode.TreeItem` - node model with `FlakeNodeType` enum |
| `nixRunner.ts` | `NixRunner` class - Nix CLI wrapper with process management |
| `statusView.ts` | `StatusViewProvider implements vscode.WebviewViewProvider` - status panel webview |
| `logger.ts` | `Logger` singleton - file logger to `~/nix-viewer-debug.log` |

## Key Classes & Methods

### FlakeTreeProvider (`flakeTreeProvider.ts`)
- `getChildren(element?)` - Returns child nodes; handles root vs nested
- `getRootChildren()` - Fetches top-level outputs via `nix flake show --json`
- `fetchAttrsetChildren(parent)` - Gets attribute names for sets
- `fetchListChildren(parent)` - **OPTIMIZED**: Fetches all list elements in single Nix eval
- `refresh()` / `refreshNode(node)` - Triggers tree refresh
- `lastGoodChildren: Map` - Caches last successful results for error resilience

### FlakeNode (`flakeNode.ts`)
- `attrPath: string` - Full dot-separated path (e.g., `nixosConfigurations.myhost.config`)
- `nodeType: FlakeNodeType` - One of: `Attrset`, `List`, `ListElement`, `Derivation`, `Leaf`, `Error`, `Loading`
- `cache?: FlakeNodeCache` - Cached children and values
- `updateAppearance()` - Sets icon/collapsibility based on type
- `setValue(value)` - Formats value for display in tree
- `createChild(name, nodeType, listIndex?)` - Factory for child nodes

### NixRunner (`nixRunner.ts`)
- `run(args, options, key?, debounce?)` - Execute nix command with optional debouncing
- `cancel(key)` / `cancelAll()` - Cancel running processes via SIGTERM
- `flakeShow(flakePath)` - Run `nix flake show --json`
- `getAttrNames(flakePath, attrPath)` - Get attribute names of a set
- `getValue(flakePath, attrPath)` - Get evaluated value
- `getValueType(flakePath, attrPath)` - Get `builtins.typeOf` result
- `isDerivation(flakePath, attrPath)` - Check if value is a derivation
- `getListElementsInfo(flakePath, attrPath)` - **BATCH**: Get all list element info in one call
- `parseAttrPath(attrPath)` - Parses paths with bracket notation
- `buildEvalArgs(attrPath, applyExpr?)` - Builds eval args, converting `.[n]` to `builtins.elemAt`

### Logger (`logger.ts`)
```typescript
import { logger } from './logger';
logger.log('message');
logger.error('message', error);
```

## Critical Patterns

### Attribute Path Notation
- Standard paths: `nixosConfigurations.myhost.config`
- List elements use bracket notation: `environment.systemPackages.[0]`
- `nixRunner.parseAttrPath()` converts `.[n]` to `builtins.elemAt` for Nix eval

### List Performance Optimization
**Problem**: Lists can have hundreds of items. Avoid N+1 Nix eval calls.
**Solution**: Use `nixRunner.getListElementsInfo()` which fetches all element metadata in a single `builtins.genList` call. See `flakeTreeProvider.fetchListChildren()`.

### Error Resilience
- `flakeTreeProvider.lastGoodChildren` map caches last successful results
- On eval failure, return cached children instead of empty/error state
- Nodes cache children in `node.cache` property

### Process Management
- `NixRunner.activeProcesses` tracks spawned processes by key
- New evals with same key cancel pending ones (via SIGTERM)
- 30-second default timeout; configurable debounce (default 500ms)

## Development Workflow

```bash
# Build (runs automatically in watch mode via npm: watch task)
npm run compile

# Debug: Use "Run Extension" launch config (F5)
# Opens extension dev host; test against a flake project

# View logs in real-time (separate terminal)
tail -f ~/nix-viewer-debug.log
```

### Common Issues
- **Nix flag errors**: Check `nixFlakeExplorer.nixArgs` setting
- **Slow loading**: Usually means per-item evaluation; use batch methods
- **"Not an attribute set"**: Path syntax issue with list indices

## Extension Configuration (package.json)
Key settings under `nixFlakeExplorer.*`:
- `rootPath`: Filter tree to specific attr path (default: `""`)
- `nixArgs`: Extra args (default: `["--offline"]`)
- `experimentalFeatures`: Nix features (default: `["nix-command", "flakes"]`)
- `debounceMs`: File watch debounce delay (default: `500`)
- `watchPatterns`: Glob patterns for file watching (default: `["flake.nix", "flake.lock", "**/*.nix"]`)

## Commands & Views
- View container: `flakeExplorer` (Activity Bar)
- Tree view: `flakeOutputsTree`
- Status webview: `flakeStatus` (collapsed by default)
- Commands: `flakeExplorer.refresh`, `flakeExplorer.openValue`, `flakeExplorer.copyPath`, `flakeExplorer.setRootPath`

## When Adding Features
1. New node types → add to `FlakeNodeType` enum in `flakeNode.ts`, update `updateAppearance()`
2. New Nix operations → add method to `NixRunner`, use `buildEvalArgs()` for path handling
3. New commands → register in `extension.ts`, add to `package.json` contributes.commands
4. Debug with `logger.log()` / `logger.error()` → check `~/nix-viewer-debug.log`

# Nix Flake Outputs Explorer

A VS Code extension that provides a tree view to browse and inspect Nix flake outputs interactively.

## Features

- **Activity Bar View**: Dedicated sidebar tab for exploring flake outputs
- **Lazy Tree Expansion**: Efficiently queries only the attributes you expand
- **Live Updates**: Automatically refreshes when `.nix` files change
- **Error Resilience**: Keeps last-known values visible when evaluation fails
- **Derivation Support**: Displays package lists with friendly names and lets you inspect derivation details
- **Configurable Root Path**: Focus on a specific part of your flake (e.g., `nixosConfigurations.myhost.config`)

## Requirements

- **Nix** with flakes enabled (`nix-command` and `flakes` experimental features)
- A workspace containing a `flake.nix`

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `nixFlakeExplorer.rootPath` | `""` | Attribute path to use as tree root |
| `nixFlakeExplorer.nixArgs` | `["--no-write-lock-file", "--offline"]` | Extra args for nix commands |
| `nixFlakeExplorer.experimentalFeatures` | `["nix-command", "flakes"]` | Nix experimental features |
| `nixFlakeExplorer.debounceMs` | `500` | Debounce delay before refresh |
| `nixFlakeExplorer.watchPatterns` | `["flake.nix", "flake.lock", "**/*.nix"]` | File patterns to watch |

## Usage

1. Open a folder containing a `flake.nix`
2. Click the **Flake Explorer** icon in the Activity Bar
3. Expand attributes to browse the flake outputs
4. Right-click items to copy paths or open values
5. Use the refresh button to manually reload

## Development

```bash
cd extension
npm install
npm run compile
# Press F5 in VS Code to launch Extension Development Host
```

## License

MIT

## Plan: Flake Outputs Explorer Extension

Create a VS Code Activity Bar tab that renders a lazy tree of flake outputs starting at a configurable “root attr path”. Node expansion uses small `nix eval` queries (mostly `builtins.attrNames` / `builtins.elemAt`), with debounced file watching to refresh values. On evaluation errors, keep the last-good tree visible and show the error in a dedicated status pane at the bottom.

### Steps
1. Scaffold the extension under `extension/` with TypeScript, bundling, and a view container contribution.
2. Add settings for root path and nix args; default args: `--no-write-lock-file --offline` (and optional experimental-features toggle if needed).
3. Implement a lazy `TreeDataProvider` that expands attrsets via `builtins.attrNames` and reads leaves via `nix eval --json .#<path>`.
4. Add list handling: render lists as expandable nodes with index children; for “derivation-like” items, compute display labels via mapping (`pname` → `name` fallback).
5. Add “Open Value” / “Open Derivation” actions: for a list item, fetch `.drvPath` via `--apply 'xs: (builtins.elemAt xs i).drvPath'`, then show `nix derivation show <drvPath>` JSON in a readonly editor.
6. Add caching + resiliency: keep a last-good snapshot per node; on refresh failures, don’t clear the tree—only update the status view text and keep cached values.

### Further Considerations
1. Root path semantics: default `""` (flake outputs root) vs default `"nixosConfigurations"` for speed.
2. Derivation detection: treat an attrset with `type == "derivation"` or with `.drvPath` as “derivation-like”.
3. Performance guardrails: cap auto-expansion depth and avoid evaluating large subtrees unless explicitly opened.

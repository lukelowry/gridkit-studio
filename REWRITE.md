# Latkit-native implementation

Branch: `rewrite/latkit-native`. Published npm versions verified on 2026-10-03:
model 3.0.0, GPU 0.14.0, Network 0.18.0, Diagram 0.8.0, Monitor 0.13.0.

## Ownership

The native .case.json TextDocument owns editable truth. Documents serializes revision-checked transactions and applies one WorkspaceEdit per gesture. Native saving, undo, and Git remain authoritative.

A lazy worker owns source mirrors, parsing, column projections, source locations, queries, layout preparation, simulation, result decoding, and indexes. Text changes are debounced and sent as deltas. The worker currently reparses the immutable projection after a delta. No application Model or local connection wrapper exists.

Each webview owns its renderer and GPU. Monitor plots share one GPU within their view. DataBatch messages carry compact owned typed arrays. One outstanding batch waits for a consumption acknowledgement; each stream is limited to 64 MiB. Case queries are cancellable and limited to 100 rows; a webview allows 16 pending requests. Hidden/disposed views cancel requests, and recreated views start with a full base projection.

Network and Diagram are custom text editors. Case and Monitor are native bottom-panel WebviewViews. Inspector/Signals use native trees; actions use native menus, title actions, Quick Picks, Settings, and tasks. Camera changes survive data updates. Incompatible sample overlays are withheld.

## Single definitions

`catalog.json` is the only authored domain definition. The compiler derives the Latkit schema, parser plans, field editing, diagnostics, completions, and simulation parameters.

`src/preferences.ts` is the single typed display-settings catalog adapted from Lattice. `pnpm settings` generates native manifest settings, and `pnpm settings:check` checks for drift. All 139 applicable settings retain Lattice defaults; VS Code supplies theme selection.

## Provenance

- GridKit Server `d0824fc`: imported catalog, parser/column compiler, simulation parameter and staging contract, Arrow/CSV decoding. Adapted into Studio; no sibling runtime dependencies.
- Lattice `8100c24e`: topology interpretation, settings/defaults, Network/Diagram/Monitor option mapping, field-binding styles, semantic palette roles, plot axes/scrubbing, deterministic unplaced-network layout, geographic border decoder/data.
- Unplaced layout has bounded work, yields for cancellation in the data worker, and uses a circle beyond 2,000 vertices.
- Geographic border data is Lattice's Natural Earth 5.1.2 derivative (public domain), copied to the packaged webview asset directory.
- Git review uses the built-in `vscode.git` version 1 API and `vscode.diff`. It adds no SCM provider or shell Git execution to the extension.

See THIRD_PARTY_NOTICES.md for upstream licenses.

## Verification

The current suite covers catalog/parser/results contracts, owned buffers, signal wiring and new net creation, guarded deletion, batched edits, UTF-16 deltas, source preservation, native settings and menu contexts, and worker acknowledgement/cancellation/mirror semantics.

Actual VS Code 1.135 and 1.140 tests exercise rendered Network/Diagram/Monitor, bottom-panel placement, native context menus, table editing, shared undo/redo, stale edits, invalid JSON recovery, saved diagram arrangement/undo, live Settings, Git diff, playback, hide/restore, high contrast, and read-only AI queries. Screenshots include 1600×1000 and 1280×800 workbenches.

Local benchmark on 2026-10-03 (single run; environment-specific):
- ACTIVSg2000: 169 ms parse; 0.60 ms visible-row query P95.
- ACTIVSg10k: 499 ms parse; 0.38 ms visible-row query P95.
- A name edit sends a 51-byte delta; projection roundtrip 149/538 ms respectively.
- Parent-thread timer drift reached 30 ms during the benchmark; this is not a claim of a zero-stall extension host.
- Two large CSV imports produced 2,403 frames each with roughly 10–11 MiB cached.
- Eight open/release cycles left zero sessions/runs/cache bytes and stable array-buffer allocation.
- Docker Arrow/CSV runs produced equivalent 11-frame results; cancellation retained 64 partial frames and cleanup finished in roughly 1.1 seconds.
- Native host activation was about 82 ms in the measured run. A single field edit produced a 290-byte Git diff.

The 0.3.1 package also passed installation and automatic case-file activation using the installed VS Code 1.135 executable. CI tests packaged installs on the minimum supported version and current stable. API types are pinned to 1.134, the newest published declarations before 1.135, to prevent accidental newer-API dependencies.

Reports are written under output/tests; packaged tests write under output/packaged-*/tests. Run timings vary with machine/GPU and competing processes.

Installed DynamicSimulation, Podman, non-Windows workbenches, and remote development are supported by the code paths but were not exercised locally. CI defines OS/build and VS Code host coverage. Arbitrary component creation, incremental column reparsing, remote model connections, and video export remain outside this implementation.

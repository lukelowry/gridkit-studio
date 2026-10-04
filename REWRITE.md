# Latkit-native implementation

Branch: `rewrite/latkit-native`. Published npm versions verified on 2026-10-03:
model 3.0.0, GPU 0.14.0, Network 0.18.0, Diagram 0.8.0, Monitor 0.13.0.

## Ownership

The native .case.json TextDocument owns editable truth. Documents serializes revision-checked transactions and applies one WorkspaceEdit per gesture. Native saving, undo, and Git remain authoritative.

A lazy worker owns source mirrors, parsing, column projections, source locations, queries, layout preparation, simulation, result decoding, and indexes. Text changes are debounced and sent as deltas. The worker currently reparses the immutable projection after a delta. No application Model or local connection wrapper exists.

Each webview owns its renderer and GPU. Monitor plots share one GPU within their view. DataBatch messages carry compact owned typed arrays. One outstanding batch waits for a consumption acknowledgement; each stream is limited to 64 MiB, and a video export's to 1 GiB. Case queries are cancellable and limited to 100 rows; a webview allows 16 pending requests. Network and Diagram keep their webview while hidden and stand still there: showing one again sends only what changed. The panels' views are destroyed when hidden; a recreated view starts with a full base projection. An export's panel keeps working while folded away.

A view is streamed the case's rows once, and the samples of the fields it draws. While a run's samples for those fields fit in 48 MiB the view holds the whole run, and each publication appends only its new pages; past that it holds a window of the run (the Monitor's visible times with a margin, the Network's few seconds around the playhead), re-requested as it is left. The Network keeps the case as its topology source and reads samples through its styles, so appended frames restyle without redrawing geometry; over a finished run held whole, bound colors span the run's range rather than each frame's.

Playback is one clock a case, Lattice's Transport, held in the extension. It changes only on play, pause, seek, rate, repeat, and arriving frames; each view integrates it locally on its own animation frames, so playing and scrubbing cross no process boundary per frame. A view's seek paints at once and is confirmed to the others.

Network and Diagram are custom text editors. Case and Monitor are native bottom-panel WebviewViews; Mappings, DynamicSimulation, and Export are sidebar WebviewViews. Inspector/Signals use native trees; workbench actions use native menus, title actions, Quick Picks, Settings, and tasks, while controls coupled to a canvas (projection, rotation, fit, playback, mapping, export) are drawn in the view with Lattice's components. Camera changes survive data updates and a replaced GPU. Incompatible sample overlays are withheld.

## Single definitions

`catalog.json` is the only authored domain definition. The compiler derives the Latkit schema, parser plans, field editing, diagnostics, completions, and simulation parameters.

`src/preferences.ts` is the single typed display-settings catalog adapted from Lattice. `pnpm settings` generates native manifest settings, and `pnpm settings:check` checks for drift. All 139 applicable settings retain Lattice defaults; VS Code supplies theme selection.

## Provenance

- GridKit Server `d0824fc`: imported catalog, parser/column compiler, simulation parameter and staging contract, Arrow/CSV decoding. Adapted into Studio; no sibling runtime dependencies.
- Lattice `8100c24e`: topology interpretation, settings/defaults, Network/Diagram/Monitor option mapping, field-binding styles, semantic palette roles, plot axes/scrubbing, deterministic unplaced-network layout, geographic border decoder/data.
- Lattice `4d7e9cf2`: the playback Transport and its tests, the token and component layers (re-pointed at workbench theme colors), glyphs, CanvasHost, Section, Switch and Row, the Monitor header and Transport, the Mappings panel and editor, the view toolbar, and video export over `@latkit/video` 0.6.0.
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

Installed DynamicSimulation, Podman, non-Windows workbenches, and remote development are supported by the code paths but were not exercised locally. CI defines OS/build and VS Code host coverage. Arbitrary component creation, incremental column reparsing, and remote model connections remain outside this implementation.

## Network opening, 0.3.2

Network uses the full editor area: no webview padding or selection footer. GPU and renderer initialization overlap worker parsing; the first frame uses current settings immediately. The Network stream contains only drawn types. Geographic boundaries load after the first network frame and cannot block case interaction. DynamicSimulation has no results-format selector; Arrow remains the default.

Measured locally on VS Code 1.135 using pnpm test:startup: ACTIVSg2000 first visible frame decreased from 2,526 to 446 ms; ACTIVSg10k from 3,390 to 981 ms. These are sequential opens in one fresh extension-host session, not cold GPU measurements for each case. The first IEEE39 open still costs roughly 1.3–1.5 seconds for cold workbench/GPU startup. Reports and stage timings are under output/startup-before and output/startup-final; results vary by hardware.

## Lattice interface

The views now carry Lattice's own controls: the Network toolbar, the Monitor header and Transport, the Mappings panel, and video export, written against Lattice's tokens on the workbench theme. See DESIGN.md.

Measured locally on 2026-10-04 with VS Code 1.135, single runs:
- The host suite applies a mapping from the panel, plays and steps from the Monitor, checks that the Network draws frame after frame from a mapped signal while the clock plays, and exports a 720p WebM of Network and Monitor (51.5 KB for a one-second run).
- First frame against the previous commit, run back to back on the same machine: ACTIVSg2000 51 to 65 ms from data to frame (54 before); ACTIVSg10k 90 to 91 ms (94 before). The opening path is unchanged within noise.
- A worker contract test covers appended streams: a view holding every page is sent nothing, and one page behind is sent that page.
- With `GRIDKIT_TEST_LIVE=1` the host suite also runs IEEE39 in the Docker image with a signal mapped to vertex color and height: 1,001 frames over 10 s arrive appended, the playhead follows the head and rests at the end, the Monitor is shown again when the run completes, and a seek repaints the Network from what it holds.
- A hidden Network keeps its webview and draws nothing while the clock plays.

Not exercised: the windowed path for runs too large to hold whole, and video export under CI's software GPU.

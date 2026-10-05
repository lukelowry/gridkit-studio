# Latkit-native implementation

Published npm versions used by this implementation:
model 4.0.0, GPU 0.15.0, Network 0.19.0, Diagram 0.9.0, Monitor 0.14.0, Video 0.6.1.

## Source layout

VS Code-specific modules live in `src/extension/`; cross-process types and helpers live in `src/shared/`. GridKit adapters, result readers, and webview implementations retain their own folders. `src/worker.ts` is the worker entry point. Tests beside source modules run in Vitest; `tests/vscode/` runs in an isolated VS Code profile.

## Ownership

The native .case.json TextDocument owns editable truth. Documents serializes revision-checked transactions and applies one WorkspaceEdit per gesture. Native saving, undo, and Git remain authoritative.

A lazy worker owns source mirrors, parsing, column projections, source locations, queries, layout preparation, simulation, result decoding, and indexes. Text changes are debounced and sent as deltas. The worker currently reparses the immutable projection after a delta. No application Model or local connection wrapper exists.

Each webview owns its renderer and GPU. Monitor plots share one GPU within their view. DataBatch messages carry compact owned typed arrays. One outstanding batch waits for a consumption acknowledgement; each stream is limited to 64 MiB, and a video export's to 1 GiB. Case queries are cancellable and limited to 100 rows; a webview allows 16 pending requests. Network and Diagram keep their webview while hidden and stand still there: showing one again sends only what changed. Monitor is also retained and idle when hidden. Case Table, Mappings, and DynamicSimulation views are destroyed when hidden; a recreated view starts with a full base projection. Video Export keeps working while folded away.

A view is streamed the case's rows once, and the samples of the fields it draws. While a run's samples for those fields fit in 48 MiB the view holds the whole run, and each publication appends only its new pages; past that it holds a window of the run (the Monitor's visible times with a margin, the Network's few seconds around the playhead), re-requested as it is left. The Network keeps the case as its topology source and reads samples through its styles, so appended frames restyle without redrawing geometry; over a finished run held whole, bound colors span the run's range rather than each frame's.

Playback is one clock a case, held in the extension. It changes only on play, pause, seek, rate, repeat, and arriving frames; each view integrates it locally on its own animation frames, so playing and scrubbing cross no process boundary per frame. A view's seek paints at once and is confirmed to the others.

Network and Diagram are custom text editors. Case Table and Monitor are native bottom-panel WebviewViews; Mappings, DynamicSimulation, and Video Export are sidebar WebviewViews. Inspector uses a native tree; VS Code actions use native menus, title actions, Quick Picks, Settings, and tasks, while controls coupled to a canvas (projection, rotation, fit, playback, mapping, export) are drawn in the view with the shared components. Camera changes survive data updates and a replaced GPU. Incompatible sample overlays are withheld.

Recording choices are saved per case, including an intentionally empty selection. Parse failures are sent to every view, even before a valid revision exists. Diagram arrangement follows its renderer lifetime and cannot commit after closure. Video output is staged beside its destination; cancellation removes only that temporary file, and successful local output uses a same-filesystem rename. Other providers supply their own rename guarantees.

## Single definitions

`catalog.json` is the only authored domain definition. The compiler derives the Latkit schema, parser plans, field editing, diagnostics, completions, and simulation parameters.

`src/shared/preferences.ts` is the single typed display-settings catalog. `pnpm settings` generates native manifest settings, and `pnpm settings:check` checks for drift. VS Code supplies theme selection.

## Provenance

- GridKit Server `d0824fc`: imported catalog, parser/column compiler, simulation parameter and staging contract, Arrow/CSV decoding. Adapted into Studio; no sibling runtime dependencies.
- Unplaced layout has bounded work, yields for cancellation in the data worker, and uses a circle beyond 2,000 vertices.
- Geographic border data is a Natural Earth 5.1.2 derivative (public domain), copied to the packaged webview asset directory.
- Git review uses the built-in `vscode.git` version 1 API and `vscode.diff`. It adds no SCM provider or shell Git execution to the extension.

See THIRD_PARTY_NOTICES.md for upstream licenses.

## Historical verification

The suite at the time covered catalog/parser/results contracts, owned buffers, signal wiring and new net creation, guarded deletion, batched edits, UTF-16 deltas, source preservation, native settings and menu contexts, and worker acknowledgement/cancellation/mirror semantics.

Actual VS Code 1.135 and 1.140 tests exercise rendered Network/Diagram/Monitor, bottom-panel placement, native context menus, table editing, shared undo/redo, stale edits, invalid JSON recovery, saved diagram arrangement/undo, live Settings, Git diff, playback, hide/restore, high contrast, and read-only AI queries. Screenshots include 1600×1000 and 1280×800 VS Code windows.

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

Direct execution of installed DynamicSimulation, non-Windows VS Code windows, and remote development were not exercised in these local historical measurements. CI defines OS/build and VS Code host coverage. Arbitrary component creation, incremental column reparsing, and remote model connections remain outside this implementation.

## Network opening, 0.3.2

Network uses the full editor area: no webview padding or selection footer. GPU and renderer initialization overlap worker parsing; the first frame uses current settings immediately. The Network stream contains only drawn types. Geographic boundaries load after the first network frame and cannot block case interaction. DynamicSimulation has no results-format selector. This revision used Arrow by default; the compatibility correction below replaces that unverified default.

Measured locally on VS Code 1.135 using pnpm test:startup: ACTIVSg2000 first visible frame decreased from 2,526 to 446 ms; ACTIVSg10k from 3,390 to 981 ms. These are sequential opens in one fresh extension-host session, not cold GPU measurements for each case. The first IEEE39 open still costs roughly 1.3–1.5 seconds for cold VS Code/GPU startup. Reports and stage timings are under output/startup-before and output/startup-final; results vary by hardware.

## Interface

The views carry their own controls: the Network toolbar, the Monitor header and transport, the Mappings panel, the DynamicSimulation form, and video export, written against one set of tokens on the VS Code theme. See DESIGN.md.

Measured locally on 2026-10-04 with VS Code 1.135, single runs:
- The host suite applies a mapping from the panel, plays and steps from the Monitor, checks that the Network draws frame after frame from a mapped signal while the clock plays, and exports a 720p WebM of Network and Monitor (51.5 KB for a one-second run).
- First frame against the previous commit, run back to back on the same machine: ACTIVSg2000 51 to 65 ms from data to frame (54 before); ACTIVSg10k 90 to 91 ms (94 before). The opening path is unchanged within noise.
- A worker contract test covers appended streams: a view holding every page is sent nothing, and one page behind is sent that page.
- An earlier Docker-based test also ran IEEE39 with a signal mapped to vertex color and height: 1,001 frames over 10 s arrive appended, the playhead follows the head and rests at the end, the Monitor is shown again when the run completes, and a seek repaints the Network from what it holds.
- A hidden Network keeps its webview and draws nothing while the clock plays.

- The rule for the window of a run a view holds, and the worker's window filter, have unit and contract tests; no test drives a run large enough to take that path through the views.

The Signals tree is gone: what a run records is chosen under Monitored signals in the DynamicSimulation panel, which has its own Run, and a signal is plotted from Add plot in the Monitor's header. Parameters that name an element are picked from the case's elements. The Monitor keeps its webview while hidden, as the canvases do.

Not exercised: video export under CI's software GPU. Known and open: the Diagram's layout is latkit's and is superlinear; measured here, 1,338 blocks (ACTIVSg2000) take 18 to 30 s to a first frame and ACTIVSg10k exceeds the layout time limit.

## DynamicSimulation compatibility correction

The earlier checks above did not establish native compatibility. The verified GridKit image reads monitor destinations from the staged case, supports CSV output, and reads Ieeet1.Ispdlim as a real number. Studio now preserves that native type, replaces inherited output destinations in the case, and runs CSV only, with no results-format parameter. Arrow imports remain supported. Native errors and a bounded solver log survive failures, including native failures that exit with code zero.

Run opens Monitor immediately. The first sample publication makes a run readable before views request its samples; this prevents a startup race that previously left an empty plot. Native result tests check both IEEE39 and TwoArea, including actual trace pixels and inspected values, fault events, cancellation, and retry. Network source revisions replace geometry and field inputs together, including switching between calculated and geographic positions.

`pnpm test:devcontainer` is the required full verification command. It fails on missing GridKit or skipped UI tests, checks an installed VSIX, compares reviewed pixel baselines, and exercises Workspace Trust. Solver artifacts and failed UI inputs/logs/reports remain under `output/`. The historical large-Diagram layout limitation above remains outside this correction.

## Where GridKit runs

A run uses the first GridKit it finds: GridKit Path, then `DynamicSimulation` on the workspace host's `PATH` (a dev container, SSH remote, or WSL with GridKit), then GridKit Image in Docker or Podman. Studio never pulls an image; one not on the machine is refused with the pull command for the reader to run. Each container run is `run --rm --pull never --network none` with only its run folder mounted, named so Stop, a worker failure, or shutdown removes it by name. On Linux it runs as the reader, or with `--userns keep-id` under Podman, and the mount is labeled for SELinux.

Measured locally on 2026-10-05, Windows with Docker Desktop and no GridKit installed: the solver suite (10 tests, including a cancelled run leaving no container and an image not on the machine refused without pulling) and the VS Code Run and WECC240 suites (13 tests) passed against `ghcr.io/lukelowry/gridkit:arrow`. Podman's arguments are unit-tested; no Podman host was exercised.

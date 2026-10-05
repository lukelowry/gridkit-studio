# GridKit Studio

Explore, edit, and simulate GridKit cases inside VS Code with current Latkit renderers.

## Running GridKit

Viewing and editing cases needs nothing else. **Running DynamicSimulation needs GridKit**, and Studio uses the first of these it finds:

1. **GridKit Path** (`gridkitStudio.gridkitPath`): an install folder such as `/opt/gridkit`, or the program itself.
2. **`DynamicSimulation` on `PATH`** where the workspace is. Studio runs beside the workspace, so in a **dev container**, an **SSH remote**, or **WSL** it finds the GridKit installed there. The `ghcr.io/lukelowry/gridkit:arrow` image has it on `PATH`; a case folder's `.devcontainer/devcontainer.json` can be as small as `{ "image": "ghcr.io/lukelowry/gridkit:arrow" }`.
3. **GridKit Image** (`gridkitStudio.gridkitImage`): a container image with GridKit, run with **Docker or Podman** where GridKit is not installed, such as Windows or macOS with Docker Desktop or Podman Desktop.

Studio never pulls an image. Pull it yourself, then name it:

```sh
docker pull ghcr.io/lukelowry/gridkit:arrow    # or: podman pull ghcr.io/lukelowry/gridkit:arrow
```

```jsonc
// settings.json
"gridkitStudio.gridkitImage": "ghcr.io/lukelowry/gridkit:arrow",
"gridkitStudio.containerCli": "podman" // optional: empty uses docker, else podman, on PATH
```

Each run gets a container of its own: `run --rm --pull never --network none` with only that run's folder mounted, removed when the run ends or you press Stop. On Linux it runs as you (`--user`, or `--userns keep-id` for rootless Podman), and the mount is labeled for SELinux. An image that is not on the machine is refused with the pull command to run.

An installed GridKit always comes first, so one set of user settings works on a laptop with Docker and in a dev container with GridKit. To use a container that is already running, attach VS Code to it with **Dev Containers: Attach to Running Container…**; Studio then runs inside it and finds GridKit on its `PATH`. **Where GridKit Runs**, in the DynamicSimulation panel's menu and the Command Palette, opens these three settings. Runs require a trusted workspace, and an untrusted workspace's values for these settings are ignored.

## Using the extension

Requires **VS Code 1.135 or later**. Install the prerelease VSIX with **Extensions: Install from VSIX…**, then open a `*.case.json`.

- **Network** is the default editor. **Reopen Editor With…** opens Diagram or JSON on the same document. The controls over its top right switch projection (each offered only where the case can be seen so), start Auto-rotate, and fit the view.
- **Case Table** is a native bottom panel. Its title actions choose the element type, filter, and columns. Click headers to sort; use F2 or double-click to edit.
- **Diagram** supports directed ports and fan-out nets. Toggle editing in the native editor title, drag blocks to place them, and drag ports to wire them. Native context menus disconnect ports and delete unreferenced elements. **Arrange Diagram** saves the selected automatic layout to the case.
- **Inspector**, **Mappings**, **DynamicSimulation**, and **Video Export** fold in the GridKit sidebar. Native menus, Quick Picks, editor/view title actions, and task terminals handle VS Code actions.
- **Mappings** lists each drawn type's parameters and signals. Open a field to check the display channels it drives, optionally over a fixed value range, and Apply; mapping a signal also records it in the runs to come.
- **Monitor** lives in the bottom panel, one lane a signal, added from the list in its header. Its header holds the playback controls: sample steps, play, the time, speed, repeat, and Go live while a run is arriving. Moving the pointer over a paused plot seeks; every view of the case paints at the same playhead.
- **Video Export** records Network, Diagram, and the Monitor's plots into an MP4 or WebM file over a chosen span of the run, on renderers of its own so VS Code stays usable.
- **Review Case Changes** opens the native Git diff against HEAD, including unsaved changes. Source Control owns staging, commits, and conflict resolution.

Network, Diagram, Case Table, and JSON share native saving, dirty state, undo/redo, and linked selection. Structured edits preserve untouched text, unknown properties, and numeric spelling. Diagram positions are stored in the component's `extension.diagram.position`. Wiring two disconnected ports creates a Signal record; an arbitrary component-creation palette is not included.

## Settings and simulation

The native Settings UI exposes **138 display settings** for Network, Diagram, Monitor, and accessibility. Search `gridkitStudio.network`, `gridkitStudio.diagram`, or `gridkitStudio.monitor`; canvas context menus open the relevant settings. This includes geometry, labels, ports, routing/layout, colors, colormaps, lighting, camera, picking, input, antialiasing, trace/axis styling, and motion. VS Code supplies the theme and font. Six field-mapping channels control vertex color/size/height and edge color/width/dashes; the Mappings panel assigns them.

GridKit app names stay explicit: `DynamicSimulation` and `ContingencyAnalysis`. The current extension runs `DynamicSimulation`.

DynamicSimulation uses catalog-derived command parameters. **Monitored signals**, directly below Run, chooses what the next run records, with Select all and Clear for each component type. Existing results and their plots keep their recorded signals. Press **Run** to open Monitor immediately; its first plot is selected automatically from the run's signals. Add further plots with **Add plot**. Native task terminals and **Show Output** retain solver logs without taking over the Monitor. Stop cancels the process and keeps available partial results. Unsaved case content is captured at run start.

Execution requires a trusted workspace and GridKit, found as [Running GridKit](#running-gridkit) describes. Runs write **CSV**, the format the verified runtime supports; there is no results-format parameter. **Import Results…** accepts Arrow and CSV; **Export CSV…** exports a run. Each staged case owns its output destination, replacing inherited monitor paths. Native failures retain a bounded `solver.log` beside the staged inputs.

Each run retains its input revision. Incompatible results never silently overlay an edited case. Failed/cancelled runs keep available partial samples visibly incomplete. Current and previous runs remain until cleared or closed; exported files remain user-owned. Raw files back windowed reads, with a shared 256 MiB sample cache by default.

WebGPU is required only for canvas views. Source, Case Table, Inspector, and execution remain available without it. Four read-only VS Code language-model tools inspect open cases, bounded rows, diagnostics, and runs without a separate chat UI, provider, or credentials.

## Develop

Use Node.js 24 and pnpm 10.30.0. Published Latkit dependencies are pinned exactly: model 4.0.0, GPU 0.15.0, Network 0.19.0, Diagram 0.9.0, Monitor 0.14.0, and Video 0.6.1. There are no sibling-repository runtime imports.

```sh
pnpm install --frozen-lockfile
pnpm quality
pnpm test:vscode
pnpm test:trust
pnpm test:gridkit
pnpm test:baselines
pnpm package
pnpm test:package
pnpm bench:gate
pnpm test:performance
```

F5 builds and opens a development host. For iteration, run `pnpm watch`, wait for its initial builds, and choose **Run GridKit Studio (watch)**; restart that host after extension-code changes. `pnpm test:watch` reruns unit tests as files change. Packaging writes `dist/gridkit-studio-<version>.vsix`.

Source organization:

```text
src/
  extension/  VS Code APIs, commands, documents, tasks, views, and file I/O
  shared/     Types, settings definitions, and helpers shared across processes
  gridkit/    Case parsing, edits, and GridKit execution
  results/    Arrow/CSV decoding and sample queries
  webview/    Latkit renderers, Svelte controls, and theme tokens
  worker.ts   Worker entry point
```

Unit tests stay beside their implementation. `tests/vscode/` contains the extension-host and UI tests; `tests/simulation/` exercises installed GridKit.

Tests are in three layers:

- **Unit** (`pnpm test`): beside the code they test, as `src/**/*.test.ts`. They run anywhere.
- **VS Code** (`pnpm test:vscode`): `tests/vscode/`, a suite for each view, run by Mocha inside an actual VS Code with its webviews, with WebGPU required for the canvas suites. UI suites reset parameters, recordings, plots, mappings, results, and selection before starting; `GRIDKIT_TEST_GREP=Monitor` runs one. `pnpm test:package` runs them against an isolated installed VSIX. `pnpm test:trust` checks inspection and blocked execution in an untrusted workspace.
- **Simulation** (`pnpm test:simulation`): real IEEE39, TwoArea, and WECC240 runs, diagnostics, native output columns, sample counts/times/reference voltages and angles, cancellation, unsupported formats, initialization errors, and retry. Inputs, results, and logs stay in `output/simulation/` for inspection. Where GridKit is not installed, `GRIDKIT_IMAGE=ghcr.io/lukelowry/gridkit:arrow` runs them through Docker or Podman (`GRIDKIT_CONTAINER_CLI` picks one), checks that a cancelled run leaves no container, and that an image not on the machine is refused, not pulled. The same variables run the VS Code Run and WECC240 suites: `GRIDKIT_IMAGE=… GRIDKIT_TEST_GREP='Run|WECC240' pnpm test:vscode`.

GridKit is Linux-only, so host UI tests on Windows or macOS skip the Run suites unless `GRIDKIT_IMAGE` names an image to run them in; without it they prove nothing about simulation. **`pnpm test:gridkit`** runs the real thing from any host with Docker: it builds the dev container's image (GridKit pinned by digest), tests a copy of the checkout in it, and leaves the host's `node_modules`, `dist`, and `.vscode-test` alone. It runs the solver tests, then the VS Code Run suites (IEEE39 and TwoArea runs, plots, playback, failures) and the WECC240 suite, which records voltage angle alone and checks each bus's color against the colormap at its recorded angle, each unmapped branch as one color (the average of its ends), and each bus's height against its angle on a tilted network. Results, screenshots, and solver logs land in `output/gridkit/`. `pnpm test:gridkit --required` is the release check that CI runs on every push (`pnpm test:devcontainer` inside the container): quality, real solver tests, the installed VSIX's full UI suite, and Workspace Trust. Missing GridKit, skipped tests, or filtered runs fail it. `GRIDKIT_PATH` names an installation elsewhere.

Linux UI tests with `GRIDKIT_TEST_SOFTWARE_GPU=1` compare committed pixel baselines for dark, light, high contrast, narrow, geographic, and mapped-color views. `pnpm test:baselines` regenerates them in the container; inspect the images in `tests/vscode/baselines/` before committing them. Failing screenshots and diffs stay under `output/`; CI uploads them.

Benchmarks follow latkit's gate. `pnpm bench` times first frame, restyle, camera move, labels, and borders on IEEE39, WECC240, ACTIVSg2000, and ACTIVSg10k, and records each scenario's exact GPU and geometry work in `output/bench/head.json`. `pnpm bench:gate` fails when that work grows past `tests/benchmarks/work.json`; it reports, without failing, scenarios slower than `output/bench/base.json` (a run of the base commit on the same machine) and time per bus that grows faster than linearly. Record intended work changes with `pnpm bench:update`. `pnpm test:performance` measures the worker separately.

See [REWRITE.md](REWRITE.md) for architecture, provenance, and verification, and [document editing](docs/table.md) for the transaction boundary.

## Author

GridKit Studio is developed by [Luke Lowery](https://lukelowry.github.io/) and began during his PhD studies at Texas A&M University. See his [Google Scholar profile](https://scholar.google.com/citations?user=CTynuRMAAAAJ&hl=en) and [GridKit](https://github.com/ORNL/GridKit).

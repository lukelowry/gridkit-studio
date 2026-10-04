# GridKit Studio

Explore, edit, and simulate GridKit cases inside VS Code with current Latkit renderers.

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

The native Settings UI exposes **139 display settings** for Network, Diagram, Monitor, and accessibility. Search `gridkitStudio.network`, `gridkitStudio.diagram`, or `gridkitStudio.monitor`; canvas context menus open the relevant settings. This includes geometry, labels, ports, routing/layout, colors, colormaps, lighting, camera, picking, input, antialiasing, trace/axis styling, and motion. VS Code supplies the theme and font. Five field-mapping channels control vertex color/size/height and edge color/dashes; the Mappings panel assigns them.

GridKit app names stay explicit: `DynamicSimulation` and `ContingencyAnalysis`. The current extension runs `DynamicSimulation`.

If you customized earlier prerelease settings, rename the boolean keys `gridkitStudio.monitor.coordinateAxis`, `gridkitStudio.monitor.valueAxis`, and `gridkitStudio.diagram.labels` by appending `.visible`. This prevents those toggles from hiding their nested formatting settings in VS Code.

DynamicSimulation uses current catalog-derived command parameters. Fill the DynamicSimulation panel (a fault's bus is picked from the case's buses), choose what to record under Recorded signals, and press Run. The run shows in a native task terminal; one that completes shows the Monitor. Stopping the task cancels and cleans up the process. Unsaved case content is captured at run start. There is no legacy solver-configuration or reference-comparison adapter.

Execution requires a trusted workspace and GridKit installed where the workspace is. Studio runs GridKit's own `DynamicSimulation` and starts nothing else: it finds it on `PATH`, or under **GridKit Path** (`gridkitStudio.gridkitPath`, such as `/opt/gridkit`). Where GridKit is installed elsewhere, open the folder there, in a dev container or over SSH or WSL; execution and files belong to the workspace extension host. Runs use Arrow by default without a format selector; CSV remains supported for programmatic execution and file exchange. **Import Results…** accepts Arrow/CSV; **Export CSV…** exports a run.

Each run retains its input revision. Incompatible results never silently overlay an edited case. Failed/cancelled runs keep available partial samples visibly incomplete. Current and previous runs remain until cleared or closed; exported files remain user-owned. Raw files back windowed reads, with a shared 256 MiB sample cache by default.

WebGPU is required only for canvas views. Source, Case Table, Inspector, and execution remain available without it. Four read-only VS Code language-model tools inspect open cases, bounded rows, diagnostics, and runs without a separate chat UI, provider, or credentials.

## Develop

Use Node.js 24 and pnpm 10.30.0. Published Latkit dependencies are pinned exactly: model 3.0.0, GPU 0.14.0, Network 0.18.0, Diagram 0.8.0, Monitor 0.13.0, and Video 0.6.0. There are no sibling-repository runtime imports.

```sh
pnpm install --frozen-lockfile
pnpm quality
pnpm test:vscode
pnpm test:trust
pnpm test:simulation
pnpm package
pnpm test:package
pnpm test:startup
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
- **Simulation** (`pnpm test:simulation`): `tests/simulation/`, GridKit's own DynamicSimulation run on a case. It needs GridKit installed, as does VS Code's Run suite, which is skipped without it.

The dev container in `.devcontainer/` is built from `ghcr.io/lukelowry/gridkit:arrow` and has GridKit installed; CI runs the simulation layer in it. `GRIDKIT_PATH` names an install elsewhere. `test:startup` and `test:performance` are benchmarks; the large CSV ones run when the ignored local result fixtures are available.

See [REWRITE.md](REWRITE.md) for architecture, provenance, and verification, and [document editing](docs/table.md) for the transaction boundary.

## Author

GridKit Studio is developed by [Luke Lowery](https://lukelowry.github.io/) and began during his PhD studies at Texas A&M University. See his [Google Scholar profile](https://scholar.google.com/citations?user=CTynuRMAAAAJ&hl=en) and [GridKit](https://github.com/ORNL/GridKit).

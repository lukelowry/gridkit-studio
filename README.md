# GridKit Studio

Explore, edit, and simulate GridKit cases inside VS Code with current Latkit renderers.

## Workbench

Requires **VS Code 1.135 or later**. Install the prerelease VSIX with **Extensions: Install from VSIX…**, then open a `*.case.json`.

- **Network** is the default editor. **Reopen Editor With…** opens Diagram or JSON on the same document.
- **Case** is a native bottom panel. Its title actions choose the element type, filter, and columns. Click headers to sort; use F2 or double-click to edit.
- **Diagram** supports directed ports and fan-out nets. Toggle editing in the native editor title, drag blocks to place them, and drag ports to wire them. Native context menus disconnect ports and delete unreferenced elements. **Arrange Diagram** saves the selected automatic layout to the case.
- **Inspector**, **DynamicSimulation**, and **Signals** use the GridKit sidebar. Native menus, Quick Picks, editor/view title actions, and task terminals handle workbench actions.
- **Monitor** lives in the bottom panel. Plot fields from Signals, then use its native play, pause, step, loop, follow, window, and plot actions. The timeline supports continuous scrubbing.
- **Review Case Changes** opens the native Git diff against HEAD, including unsaved changes. Source Control owns staging, commits, and conflict resolution.

Network, Diagram, Case, and JSON share native saving, dirty state, undo/redo, and linked selection. Structured edits preserve untouched text, unknown properties, and numeric spelling. Diagram positions are stored in the component's `extension.diagram.position`. Wiring two disconnected ports creates a Signal record; an arbitrary component-creation palette is not included.

## Settings and simulation

The native Settings UI exposes **139 Lattice settings** for Network, Diagram, Monitor, and accessibility. Search `gridkitStudio.network`, `gridkitStudio.diagram`, or `gridkitStudio.monitor`; canvas context menus open the relevant settings. This includes geometry, labels, ports, routing/layout, colors, colormaps, lighting, camera, picking, input, antialiasing, trace/axis styling, and motion. VS Code supplies the theme and font. Five field-mapping channels control vertex color/size/height and edge color/dashes.

DynamicSimulation uses current catalog-derived command parameters. Configure the sidebar form and recorded outputs, then run through a native task terminal. Stopping the task cancels and cleans up the process. Unsaved case content is captured at run start. There is no legacy solver-configuration or reference-comparison adapter.

Execution requires a trusted workspace and **DynamicSimulation**, **Docker**, or **Podman**. Auto searches in that order. Configure the executable path or container image in Settings. The default container is `ghcr.io/lukelowry/gridkit:arrow`. Runs use Arrow by default without a format selector; CSV remains supported for programmatic execution and file exchange. **Import Results…** accepts Arrow/CSV; **Export CSV…** exports a run. In SSH, WSL, or a devcontainer, execution and files belong to the workspace extension host.

Each run retains its input revision. Incompatible results never silently overlay an edited case. Failed/cancelled runs keep available partial samples visibly incomplete. Current and previous runs remain until cleared or closed; exported files remain user-owned. Raw files back windowed reads, with a shared 256 MiB sample cache by default.

WebGPU is required only for canvas views. Source, Case, Inspector, and execution remain available without it. Four read-only VS Code language-model tools inspect open cases, bounded rows, diagnostics, and runs without a separate chat UI, provider, or credentials.

## Develop

Use Node.js 24 and pnpm 10.30.0. Published Latkit dependencies are pinned exactly: model 3.0.0, GPU 0.14.0, Network 0.18.0, Diagram 0.8.0, and Monitor 0.13.0. There are no sibling-repository runtime imports.

```sh
pnpm install --frozen-lockfile
pnpm settings:check
pnpm lint
pnpm format:check
pnpm test
pnpm test:host
pnpm test:solver
pnpm test:performance
pnpm test:startup
pnpm package
pnpm test:package
```

F5 opens a development host. Packaging writes `dist/gridkit-studio-0.3.2.vsix`. The host suite uses actual VS Code and webviews and requires WebGPU. The solver suite defaults to Docker; `GRIDKIT_TEST_SOLVER` selects an installed executable and `GRIDKIT_TEST_IMAGE` selects another compatible image. Large CSV benchmarks run when the ignored local result fixtures are available.

See [REWRITE.md](REWRITE.md) for architecture, provenance, and verification, and [document editing](docs/table.md) for the transaction boundary.

## Author

GridKit Studio is developed by [Luke Lowery](https://lukelowry.github.io/) and began during his PhD studies at Texas A&M University. See his [Google Scholar profile](https://scholar.google.com/citations?user=CTynuRMAAAAJ&hl=en) and [GridKit](https://github.com/ORNL/GridKit).

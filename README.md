# GridKit Studio

Explore, edit, and simulate GridKit cases inside VS Code. Network, Diagram, Table, and JSON share the same document, including native saving, dirty state, and undo/redo.

## Use

Requires **VS Code 1.140 or later**. Install the prerelease VSIX using **Extensions: Install from VSIX…**, then open a `*.case.json`.

- **Network** is the default case editor. Use **Reopen Editor With…** for Diagram, Table, or JSON.
- Select an element to inspect its fields in the native **Inspector**. Edit with the field context menu or F2 in Table. Reference values use stable IDs such as `Bus/42`.
- **Diagram** shows directed signal ports and nets. Fit a selected element's neighborhood to inspect its connections. Cases without signal topology show an explanatory empty state.
- Choose recorded outputs in **Signals**, configure **Simulation**, and run. Execution appears in a native task terminal; stopping the task cancels and cleans up the solver.
- **Monitor** plots recorded signals, supports a shared playhead, stepping, looping, and following live results. Its initial window is at most ten seconds; pan or choose a time window to read other portions of the raw result file.
- Import existing Arrow or CSV results with **Open Monitor CSV…**; export recorded results to CSV.

A matching `*.solver.json` is detected automatically. Choose **Simulation form** to use simple catalog-derived options, or select a solver configuration for advanced settings and events. Unsaved case and configuration content is captured for each run. Legacy reference comparisons run through a CSV monitor alongside Arrow capture.

Simulation requires a trusted workspace and either an installed **DynamicSimulation**, **Docker**, or **Podman**. Auto searches in that order. Set **Dynamic Simulation Path** for your own build. The default container image is `ghcr.io/lukelowry/gridkit:arrow`, which supports Arrow streams; a runtime without that support can use CSV output instead. In SSH, WSL, or a devcontainer, execution and files live on the workspace extension host.

Each run retains its original case revision. Source edits never silently attach incompatible results. Invalid intermediate JSON leaves the last valid view visibly stale. Failed and cancelled runs retain available partial results. The current and previous run remain until cleared or the case closes; exported files are yours. Raw run files live in extension storage, with a shared 256 MiB sample cache by default. WebGPU is required for canvas views; source, Table, Inspector, and execution remain available without it.

Four read-only VS Code language-model tools expose case inspection, bounded row queries, diagnostics, and run summaries. They use open sessions and require no Studio model provider, credentials, or chat UI.

## Develop

Use Node.js 24 and pnpm 10.30.0. All Latkit dependencies are exact published npm versions; there are no sibling-repository runtime imports.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm test
pnpm test:host
pnpm test:solver
pnpm test:performance
pnpm package
```

F5 opens a development host with the bundled `cases` directory. Packaging writes `dist/gridkit-studio-0.3.0.vsix`. The host suite runs real VS Code 1.140 and webviews; rendering tests require a working WebGPU adapter. The solver suite defaults to Docker; set `GRIDKIT_TEST_SOLVER` to an installed executable path or `GRIDKIT_TEST_IMAGE` to another compatible image. Large CSV benchmarks run when the ignored local `cases/*.mon.csv` files are present.

See [REWRITE.md](REWRITE.md) for architecture, imported-code provenance, and verification evidence.

## Author

GridKit Studio is developed by [Luke Lowery](https://lukelowry.github.io/) and began during his PhD studies at Texas A&M University. See his [Google Scholar profile](https://scholar.google.com/citations?user=CTynuRMAAAAJ&hl=en) for publications and [GridKit](https://github.com/ORNL/GridKit) for more information about this work.

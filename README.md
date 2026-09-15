# GridKit Studio

View and edit GridKit cases, configure faults, simulate with DynamicSimulation, and plot the results.

## Use

Download the `.vsix` from [Releases](https://github.com/lukelowry/gridkit-studio/releases) and run **Extensions: Install from VSIX...**.

Open a `*.case.json`, configure **Simulation**, choose **Signals**, and run. A `*.solver.json` is optional. Existing monitor and reference CSVs open through **Open Monitor CSV...**. Errors appear in the task terminal and Simulation.

Requires VS Code 1.96+ and WebGPU for visualization. Simulation requires either DynamicSimulation or Docker/Podman. Container execution uses `ghcr.io/lukelowry/gridkit:latest`.

In a devcontainer or SSH session, these tools must be available there. Set **DynamicSimulation Path** to use your own build, or **Simulation Method** to select Docker or Podman. Auto prefers installed DynamicSimulation.

## Develop

Use Node.js 24 and pnpm 10.30.0. Latkit dependencies are installed from npm.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm test:host
pnpm test:solver
pnpm package
```

F5 opens the development host with `cases`. Packaging writes `dist/gridkit-studio.vsix`.

## Author

GridKit Studio is developed by [Luke Lowery](https://lukelowry.github.io/) and began during his PhD studies at Texas A&M University. See his [Google Scholar profile](https://scholar.google.com/citations?user=CTynuRMAAAAJ&hl=en) for publications and [GridKit](https://github.com/ORNL/GridKit) for more information about this work.

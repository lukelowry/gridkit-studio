# GridKit Studio

View, edit, and simulate [GridKit](https://github.com/ORNL/GridKit) power-system cases in VS Code.

![WECC240 after a bus fault, voltage angle mapped to color and height](docs/images/network.png)

## Install

In VS Code 1.135 or later, run **Extensions: Install from VSIX…**, then open a `*.case.json`. Canvas views need WebGPU.

## Run GridKit

Studio runs the first GridKit it finds:

1. **GridKit Path** (`gridkitStudio.gridkitPath`): an install folder, such as `/opt/gridkit`.
2. `DynamicSimulation` on `PATH` where the workspace is: a dev container, SSH remote, or WSL.
3. **GridKit Image** (`gridkitStudio.gridkitImage`): a container image, run with Docker or Podman.

Studio never pulls images. Pull one yourself first:

```sh
docker pull ghcr.io/lukelowry/gridkit:arrow    # or: podman pull …
```

Runs need a trusted workspace.

## Use

| View                                           | Where        |                                                                   |
| ---------------------------------------------- | ------------ | ----------------------------------------------------------------- |
| Network, Diagram                               | Editor       | Draw the case; place, wire, and arrange diagram blocks            |
| Case Table, Monitor                            | Bottom panel | Edit fields; plot and play back runs                              |
| DynamicSimulation, Monitored Signals, Mappings | Sidebar      | Run; choose what is recorded; map values to color, size, height   |
| Video Export                                   | Sidebar      | Record Network, Diagram, and Monitor to MP4 or WebM               |

![A bus fault plotted in the Monitor](docs/images/monitor.png)

Every view edits the same JSON document, with native undo, save, and Git. Settings: search `gridkitStudio`.

## Develop

```sh
pnpm install
pnpm quality        # format, lint, types, unit tests
pnpm test:vscode    # VS Code suites
pnpm test:gridkit   # everything against real GridKit in the dev container image
pnpm package        # dist/gridkit-studio-<version>.vsix
```

`GRIDKIT_IMAGE=ghcr.io/lukelowry/gridkit:arrow` runs the simulation suites on any Docker or Podman host.

## License

MIT. Bundled code, case data, and map borders: [third-party notices](THIRD_PARTY_NOTICES.md). By [Luke Lowery](https://lukelowry.github.io/).

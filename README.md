# GridKit Studio

[![CI](https://github.com/lukelowry/gridkit-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/lukelowry/gridkit-studio/actions/workflows/ci.yml)
[![GridKit v0.2.0](https://img.shields.io/badge/GridKit-v0.2.0-brightgreen)](https://github.com/ORNL/GridKit/releases/tag/v0.2.0)
[![VS Code ≥ 1.135](https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.135-007ACC?logo=visualstudiocode)](https://code.visualstudio.com/)
[![Release](https://img.shields.io/github/v/release/lukelowry/gridkit-studio?include_prereleases)](https://github.com/lukelowry/gridkit-studio/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

View, edit, and simulate [GridKit](https://github.com/ORNL/GridKit) power-system cases in VS Code.

![ACTIVSg70k, tilted: each bus voltage level as height and color](docs/media/activsg70k.png)

## Install

In VS Code 1.135 or later, run **Extensions: Install from VSIX…** with the VSIX from [Releases](https://github.com/lukelowry/gridkit-studio/releases), then open a `*.case.json`. Canvas views need WebGPU.

## GridKit

Studio uses the first GridKit it finds:

1. **GridKit Path** (`gridkitStudio.gridkitPath`): an install folder, such as `/opt/gridkit`.
2. GridKit on `PATH` where the workspace is: a dev container, SSH remote, or WSL.
3. **GridKit Image** (`gridkitStudio.gridkitImage`), in Docker or Podman: `ghcr.io/lukelowry/gridkit:latest` by default.

Studio never pulls an image; pull it yourself:

```sh
docker pull ghcr.io/lukelowry/gridkit:latest
```

## Views

| View                          | Where   |                                                          |
| ----------------------------- | ------- | -------------------------------------------------------- |
| Network, Diagram              | Editor  | Draw the case; place and wire diagram blocks             |
| Case                          | Panel   | Edit fields; map a column onto the network from its menu |
| Monitor                       | Panel   | Plot and play back results                               |
| Simulation, Monitored Signals | Sidebar | Dynamic simulation or contingency analysis               |
| Video Export                  | Sidebar | Network, Diagram, and Monitor to MP4 or WebM             |

![ACTIVSg25k mid-fault: voltage magnitude as color and height](docs/media/activsg25k.png)

![IEEE39 mid-fault: voltage magnitude on the network and in the Monitor](docs/media/monitor.png)

## License

MIT. Bundled code, case data, and map borders: [third-party notices](THIRD_PARTY_NOTICES.md). By [Luke Lowery](https://lukelowry.github.io/).

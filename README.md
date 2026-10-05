# GridKit Studio

[![CI](https://github.com/lukelowry/gridkit-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/lukelowry/gridkit-studio/actions/workflows/ci.yml)
[![GridKit v0.2.0](https://img.shields.io/badge/GridKit-v0.2.0-brightgreen)](https://github.com/ORNL/GridKit/releases/tag/v0.2.0)
[![VS Code ≥ 1.135](https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.135-007ACC?logo=visualstudiocode)](https://code.visualstudio.com/)
[![Release](https://img.shields.io/github/v/release/lukelowry/gridkit-studio?include_prereleases)](https://github.com/lukelowry/gridkit-studio/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

View, edit, and simulate [GridKit](https://github.com/ORNL/GridKit) power-system cases in VS Code.

![ACTIVSg70k with bus voltage level shown as height and color](docs/media/activsg70k.png)

## Install

Download the VSIX from [Releases](https://github.com/lukelowry/gridkit-studio/releases) and install it with **Extensions: Install from VSIX…**, then open any `*.case.json` file. Requires VS Code 1.135 or later and WebGPU.

## GridKit

Studio looks for GridKit in this order:

1. The install folder set in `gridkitStudio.gridkitPath`
2. `PATH`, including dev containers, SSH, and WSL
3. The Docker or Podman image set in `gridkitStudio.gridkitImage`

To use the default image, pull it first:

```sh
docker pull ghcr.io/lukelowry/gridkit:latest
```

## Features

- Network and diagram editors
- Case panel for editing fields and mapping them onto the network
- Dynamic simulation and contingency analysis
- Monitor for plotting and playing back signals
- Video export to MP4 or WebM

![ACTIVSg25k during a fault with voltage magnitude shown as color and height](docs/media/activsg25k.png)

_ACTIVSg25k during a fault, with voltage magnitude shown as color and height_

![IEEE39 during a fault with voltage magnitude on the network and in the Monitor](docs/media/monitor.png)

_IEEE39 during a fault, with voltage magnitude on the network and in the Monitor_

## License

MIT. See [third-party notices](THIRD_PARTY_NOTICES.md) for bundled code, case data, and map borders. Made by [Luke Lowery](https://lukelowry.github.io/).

# GridKit Studio

[![CI](https://github.com/lukelowry/gridkit-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/lukelowry/gridkit-studio/actions/workflows/ci.yml)
[![GridKit v0.2.0](https://img.shields.io/badge/GridKit-v0.2.0-brightgreen)](https://github.com/ORNL/GridKit/releases/tag/v0.2.0)
[![VS Code ≥ 1.140](https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.140-007ACC?logo=visualstudiocode)](https://code.visualstudio.com/)
[![Release](https://img.shields.io/github/v/release/lukelowry/gridkit-studio?include_prereleases)](https://github.com/lukelowry/gridkit-studio/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

View, edit, and simulate [GridKit](https://github.com/ORNL/GridKit) power-system cases in VS Code.

![ACTIVSg70k with bus voltage level shown as height and color](docs/media/activsg70k.png)

## Install

Download the VSIX from [Releases](https://github.com/lukelowry/gridkit-studio/releases) and install it with **Extensions: Install from VSIX…**, then open any `*.case.json` file. Requires VS Code 1.140 or later and WebGPU.

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

- Network editor
- Case panel for editing, sorting and filtering fields, and mapping them onto the network. What you select in the table shows on the network, and the other way around.

![ACTIVSg25k during a fault with voltage magnitude shown as color and height](docs/media/activsg25k.png)

_ACTIVSg25k during a fault, with voltage magnitude shown as color and height_

- Diagram editor for control blocks and how they're wired

![An IEEE39 generator with its exciter and stabilizer in the diagram](docs/media/diagram.png)

_An IEEE39 generator with its exciter and stabilizer in the diagram_

- Dynamic simulation and contingency analysis
- Monitor for plotting and playing back signals

![IEEE39 during a fault with voltage magnitude on the network and in the Monitor](docs/media/monitor.png)

_IEEE39 during a fault, with voltage magnitude on the network and in the Monitor_

- Video export to MP4 or WebM
- AI tools for inspecting and editing cases, starting simulations, and analyzing recorded results

## AI chat

VS Code chat and external MCP clients share the same 21 tools. Tools act on explicit cases and simulation IDs; a case editor does not need to stay open. Case edits are one undoable transaction. Simulations start as native VS Code tasks and return an ID immediately. There are no proposal documents or a second launch button.

For **Codex**, choose **GridKit Studio: Connect Codex**. For **Claude Code**, choose **GridKit Studio: Connect Claude Code**. Choose workspace AI access once: **Inspect**, **Simulate**, or **Edit and simulate**. Studio saves the project configuration, preserves unrelated servers, and tests the actual MCP connection. Restart or reconnect MCP in that client, accept its project trust prompt, and keep this VS Code workspace open. No manual copying of configuration is needed.

Use **GridKit Studio: AI Access** to change access later. Existing connections start with Inspect access until you choose otherwise. The AI client's own approvals still apply. Native VS Code chat uses VS Code's tool confirmations. Untrusted workspaces cannot execute AI tools.

**AI Connection Status** distinguishes a listening endpoint from a client that completed the MCP handshake. **Test AI Connection** checks the relay, authentication, tool discovery, and a harmless tool call; it does not claim your AI app is connected. **Connect AI Client…** also supports VS Code MCP and generic stdio clients. Claude Desktop can use the generic configuration on a local machine; the automatic Claude command targets Claude Code's project configuration.

| Work | Tools (all prefixed `gridkit_`) |
| --- | --- |
| Understand a case | `list_cases`, `describe_case`, `describe_component_type`, `check_case` |
| Inspect components and connections | `find_components`, `summarize_components`, `trace_connections` |
| Edit buses, branches and other components | `edit_case`: add, set fields, connect ports, remove and move in one atomic batch |
| Simulate | `simulate`, `list_simulations`, `get_simulation`, `stop_simulation` |
| Analyze recorded signals | `analyze_results`, `compare_results`, `rank_contingencies`, `read_signal_samples` |
| Follow analysis and retain baselines | `get_analysis`, `stop_analysis`, `set_result_retention` |
| Display | `show_component`, `plot_results` |

Start with `list_cases`, then `describe_case` and `describe_component_type`. Use the returned `caseUri`, content-based `caseRevision`, and native component identities such as `Bus/1`. `find_components` can return a reusable `selectionId` for every matching component without sending all IDs to the model. Selections belong to the current extension session; recreate an expired selection.

For example, `gridkit_edit_case` can create and connect components together, including references to components added later in the same batch:

```json
{
  "caseUri": "<caseUri from list_cases>",
  "caseRevision": "<caseRevision from describe_case>",
  "requestId": "add-tie-001",
  "changes": [
    { "kind": "add", "componentType": "Branch", "key": "tie", "fields": { "ports.bus1": "Bus/99999", "ports.bus2": "Bus/1", "params.X": 0.1 } },
    { "kind": "add", "componentType": "Bus", "key": 99999, "fields": { "name": "New bus", "params.kv": 230 } }
  ]
}
```

Choose unused identities and valid fields from the case's component definitions. Edits preserve unaffected source text and remain unsaved until the user saves. Reuse a `requestId` only for the identical edit or simulation retry; a changed payload is rejected. If a crash leaves an uncertain edit receipt, inspect the case before submitting new work. A client disconnect does not cancel an accepted simulation; stop its exact `simulationId` explicitly.

`simulate` uses GridKit's native programs (`DynamicSimulation` and `ContingencyAnalysis`), parameters (`tmax`, `dt_monitor`, and solver tolerances), and recorded fields (`Vm`, `Va`, etc.). `ContingencyAnalysis` is a **bus-fault study**, not a general branch-outage study. `fault: false` disables the additional configured fault; faults already authored in the case remain.

Analysis returns one `analysisId` for progress and paginated findings. Use `get_analysis` with `waitMs` up to 30000 to wait without repeatedly starting computations. Threshold duration is a stated estimate from original recorded samples; missing data and excessive gaps remain unknown. Envelopes from `read_signal_samples` are for visualization. Comparisons match component identities and units over a shared time interval; they do not infer pointwise differences from envelopes.

Completed recordings, captured case sources, configurations, findings, and retry receipts survive reload. Unfinished simulations become **interrupted**; Studio never silently restarts them. `gridkitStudio.resultCacheMiB` bounds decoded sample memory. `gridkitStudio.resultStorageMiB` controls automatic disk retention (4096 MiB by default), including captured sources. Findings use up to one eighth of that budget. Active work, active readers, newly produced results and explicitly retained baselines are protected, so those protections can temporarily exceed the budget. Eviction preserves simulation metadata and reports missing recordings explicitly. **Clear Results** explicitly removes a case's retained recordings.

The MCP adapter lives in the VS Code extension host. A small stdio relay connects the client to its private local socket; computation and decoding stay in the data worker, and GridKit executes locally or in its configured container. There is no network listener or separate service to install. The workspace launcher survives extension updates and reloads. If multiple connected windows hold the same workspace, it refuses to choose one; use the explicit window connection option. For SSH, WSL, or containers, the client process must be able to execute the launcher on the extension host's machine.

## Development

`src/shared/tools.ts` defines the tool contracts. `pnpm tools` generates VS Code contributions; `pnpm tools:check` detects drift. `src/extension/ai/` contains transport adapters, access, connection setup, and thin case/simulation/results/display handlers. Durable receipts, simulations and analysis lifetimes live in `src/extension/{requests,simulations,analyses}.ts`; worker snapshots and simulation ownership live in `src/worker/`. GridKit validation and atomic edits remain in `src/gridkit/`; sample math, recordings, and findings remain in `src/results/`.

Use `pnpm quality`, `pnpm test:ai`, `pnpm test:mcp`, and `pnpm test:trust` for contract checks. MCP tests use a real stdio client, isolated VS Code profiles and GridKit simulations. `pnpm test:vscode` covers the native UI; `pnpm package` and `pnpm test:package` verify the distributed extension. Simulation tests require GridKit or the configured container image.

## Author

[Luke Lowery](https://lukelowry.github.io/), PhD student in the [Birchfield Research Group](https://birchfield.engr.tamu.edu/) at Texas A&M University · [Google Scholar](https://scholar.google.com/citations?user=CTynuRMAAAAJ&hl=en) · [ORCID](https://orcid.org/0009-0000-0029-3403)

## License

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md).

Uses [GridKit](https://github.com/ORNL/GridKit) from Oak Ridge National Laboratory and cases from the [Texas A&M Electric Grid Test Case Repository](https://electricgrids.engr.tamu.edu/electric-grid-test-cases/).

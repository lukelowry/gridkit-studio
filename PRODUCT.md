# GridKit Studio

GridKit Studio is a desktop VS Code extension for inspecting, editing, and simulating GridKit power-system cases.

The source of truth is the open .case.json TextDocument. Network and Diagram are custom text editors; Case and Monitor are native bottom-panel views. Inspector, DynamicSimulation, and Signals live in the GridKit sidebar. Saving, dirty state, undo/redo, Problems, source navigation, context menus, Settings, tasks, and Git remain native VS Code workflows.

The user explicitly requires Lattice's useful settings and interaction model, compact styling, and direct published Latkit APIs. Studio exposes all 139 applicable Network, Diagram, Monitor, and accessibility settings using Lattice defaults. VS Code owns theme selection. No browser shell or compatibility subsystem is retained.

Diagram supports navigation, selection, editable fields, block placement, automatic arrangement, signal-port connection/disconnection, and guarded deletion. Wiring unconnected ports can create a Signal record. Arbitrary component creation remains a future consumer of the document transaction boundary.

The single authored domain definition is catalog.json imported from GridKit Server. Schemas, parser mappings, source intelligence, validation, and simulation parameters derive from it. Adjacent repositories are implementation references, not runtime dependencies.

The operating environment is VS Code 1.135 or later, including workspace extension hosts in remote development. DynamicSimulation requires Workspace Trust and an installed DynamicSimulation, Docker, or Podman runtime. Arrow and CSV are current supported result formats. There is no .solver.json compatibility, reference-comparison adapter, or remote-model connection.

Views remain responsive through off-thread case parsing, incremental source messages, bounded row queries, acknowledged data streams, windowed results, and a shared bounded sample cache. Canvas views require WebGPU; Case, JSON, Inspector, and simulation remain usable without it.

Four read-only VS Code language-model tools inspect open cases and runs. Studio introduces no separate chat interface, model provider, or credentials.

Network and Diagram fill the available editor area, with no webview gutters or idle selection footer. The DynamicSimulation form omits output format; Arrow is the default. Opening prioritizes the network itself over geographic decoration. Large-case opening is faster; cold GPU initialization remains a separate latency cost.

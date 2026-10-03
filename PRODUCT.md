# GridKit Studio

GridKit Studio is a desktop VS Code extension for people inspecting, editing, and simulating GridKit power-system cases.

The core workflow is to open a case, inspect its network or directed-signal diagram, edit known fields in Table or Inspector, configure a local simulation, and examine recorded signals. JSON remains the editable source of truth. Native saving, dirty state, undo/redo, Problems, trees, editor groups, commands, Quick Picks, and task terminals belong to VS Code.

The product uses published Latkit packages directly. The one authored domain definition is GridKit Server's imported catalog.json; schemas, parser mappings, editing metadata, source intelligence, and simulation parameters are derived. Adjacent repositories supply reference implementations, not runtime dependencies.

The operating environment is VS Code 1.140 or later, including workspace extension hosts in remote development. Execution requires Workspace Trust. DynamicSimulation may be installed locally or run through Docker/Podman. Canvas views require WebGPU; source, Table, Inspector, and execution remain available when it is unavailable.

The design follows the user's explicit native VS Code direction: compact, theme-aware, keyboard-accessible surfaces that belong in the IDE, including high contrast and reduced motion. There is no separate browser application shell, custom chat UI, model provider, or credentials flow.

Initial scope includes Network, Diagram navigation/inspection, editable Table and Inspector, Signals, Simulation, Monitor/playback, Arrow/CSV results, legacy solver configuration, and read-only language-model tools. Remote model connections, video export, graphical rewiring, and component creation are deferred.

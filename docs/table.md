# Table and document editing

Table is an optional custom text editor for the same VS Code TextDocument used by Network, Diagram, and JSON. The data worker parses a document revision once into Latkit Data. Table issues bounded Latkit row queries, requesting at most 100 rows and 256 KiB per block with owned buffers. It virtualizes rows with fixed 30-pixel spacing.

Column selection, name filtering, and sorting are local view preferences expressed as ordinary Latkit query fields. Responses have a generation check so an older query cannot replace newer rows. Linked selection resolves a stable domain ID to its physical row; when necessary it switches type and clears filtering/sorting to reveal that row.

F2 or double-click edits a known field. The catalog compiler determines editability: parameters, initial values, ordinary names, positions, and references are editable; identities and sampled outputs are not. Reference edits use stable IDs such as Bus/42. Minimal source replacements are applied only against the captured document version through WorkspaceEdit. JSON remains available for structural changes.

Untouched properties and numeric text are preserved. Native real-valued parameters retain fractional or exponent tokens when edited. Worker source locations translate UTF-8 offsets to VS Code's UTF-16 positions. Invalid intermediate JSON retains the last valid projection with a stale banner and disables edits until parsing succeeds.

Table does not require WebGPU. Controls use VS Code theme tokens, native HTML semantics, visible focus, and high-contrast colors. Undo and redo belong to VS Code, shared by every editor on the document.

Run `pnpm test` for source/ownership contracts and `pnpm test:host` for actual VS Code integration. `pnpm test:performance` measures 100-row queries on the bundled 2,000- and 10,000-bus cases.

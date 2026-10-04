# Documents, Case, and diagram editing

Case is a native bottom-panel view of the same TextDocument used by Network, Diagram, and JSON. Its title actions select a type, filter names, and choose columns. Column headers sort. Native context menus carry the exact case, revision, element, and field; they do not silently change selection.

Rows are virtualized at 28 pixels. Each Latkit query asks for at most 100 rows and owned 256 KiB blocks. Superseded queries are aborted through the webview, extension host, and worker. A webview has at most 16 pending requests. Playback-only changes do not restart Case queries.

F2 and double-click edit a cell. Arrow keys move between cells. Inspector uses native Quick Picks and input boxes; reference selection is searchable and bounded. The compiled catalog determines editability. Stable domain IDs identify records, while Latkit indexes resolve physical rows.

## Transaction boundary

Every structured edit calls Documents.transact with an expected document revision and typed mutations. The worker plans minimal text replacements; the host checks the revision again and commits one WorkspaceEdit. Each document serializes transactions. Stale and read-only documents reject edits.

Only touched records are materialized for editing. Multiple field changes in a record compose before a minimal replacement is produced. Untouched numeric spelling, whitespace, Unicode, line endings, and unknown properties survive. Insertions deliberately avoid a whole-record formatting pass. Worker UTF-8 source locations are converted to VS Code UTF-16 positions.

Document-change events send revisioned UTF-16 deltas to a worker source mirror. Parsing is debounced and cancelled when superseded. A missing mirror resynchronizes from the full document. The parser currently rebuilds the immutable column projection after a delta; incremental column reparsing is a future optimization, not an existing claim.

## Diagram

Toggle editing with the native editor-title action. Drag blocks to place them, drag compatible ports to wire them, and use native context actions to disconnect or delete. Required connections and remaining references guard deletion. A net has at most one output driver through the wiring operation; input fan-out is allowed. Two disconnected ports allocate one new stable Signal ID.

Positions live in each record's extension.diagram.position as [x, y]. The first move captures the automatic arrangement before changing the dragged blocks, preserving the rest of the layout. Arrange Diagram applies the selected layout settings and writes one undoable transaction. Stored positions select manual placement until arranged again.

Transactions are bounded to 10,000 changes and 4 MiB inserted text. New diagram gestures should produce these domain mutations rather than serializing the document or editing column arrays.

## Git and lifecycle

Review Case Changes lazily uses the built-in Git extension's versioned API and opens HEAD against the existing TextDocument. Unsaved edits are visible on the right side. Native Source Control owns staging, committing, history, and conflict resolution; Studio creates no competing SCM provider.

Invalid intermediate JSON leaves the last valid view visibly stale and disables structured editing. Runs retain their captured input revision. Unrelated results never overlay a changed case. Recreated webviews receive a complete base projection before sample updates; hide/dispose cancels their reads.

See REWRITE.md for commands and measured verification.

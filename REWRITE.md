# Latkit-native rewrite

The extension is being rebuilt on `rewrite/latkit-native` using published Latkit
packages and VS Code's native document, view, task, and language-model tool APIs.

The single authored GridKit definition is `catalog.json`, imported from
`gridkit-server` revision `d0824fc`. Its compiler, column parser, and result
decoders are adapted from that revision. Network and diagram topology discovery
follows `lattice` revision `8100c24e`.

The runtime Latkit schema and command parameters are derived from the catalog.
There are no authored JSON Schema files, sibling-repository imports, local model
wrappers, or application-level network transports.

Local documents remain the editable source of truth. Published arrays are
immutable. Runs retain their captured document revision. All structured edits go
through VS Code's text-edit API.

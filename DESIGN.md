---
name: GridKit Studio
description: Lattice's compact engineering views within the native VS Code workbench.
colors:
  background: 'var(--vscode-editor-background)'
  foreground: 'var(--vscode-foreground)'
  secondary-text: 'var(--vscode-descriptionForeground)'
  divider: 'var(--vscode-panel-border)'
  focus: 'var(--vscode-focusBorder)'
  input-background: 'var(--vscode-input-background)'
  input-foreground: 'var(--vscode-input-foreground)'
  row-hover: 'var(--vscode-list-hoverBackground)'
  row-selection: 'var(--vscode-list-inactiveSelectionBackground)'
  warning: 'var(--vscode-editorWarning-foreground)'
  error: 'var(--vscode-errorForeground)'
typography:
  body:
    fontFamily: 'var(--vscode-font-family, system-ui)'
    fontSize: 'var(--vscode-font-size, 13px)'
  label:
    fontFamily: 'var(--vscode-font-family, system-ui)'
    fontSize: '12px'
  numeric:
    fontFamily: 'var(--vscode-editor-font-family, monospace)'
rounded:
  control: '2px'
spacing:
  2xs: '2px'
  xs: '4px'
  sm: '8px'
  md: '12px'
  lg: '16px'
components:
  field-input:
    backgroundColor: '{colors.input-background}'
    textColor: '{colors.input-foreground}'
    rounded: '{rounded.control}'
    padding: '5px'
  table-cell:
    textColor: '{colors.foreground}'
    padding: '{spacing.xs}'
    height: '28px'
  table-cell-hover:
    backgroundColor: '{colors.row-hover}'
  table-row-selected:
    backgroundColor: '{colors.row-selection}'
  plot-heading:
    textColor: '{colors.foreground}'
    padding: '4px 12px'
  timeline:
    padding: '0 12px'
  status:
    backgroundColor: '{colors.background}'
    textColor: '{colors.foreground}'
    padding: '3px 12px'
---

# Design System: GridKit Studio

## Overview

**Creative North Star: "The native engineering workbench"**

Studio uses Lattice's compact visual vocabulary inside VS Code. The workbench owns navigation, commands, menus, settings, and document chrome. Webviews contribute the specialized canvas, table, and parameter form.

The visual system is restrained and data dense: flat surfaces, narrow separators, readable identifiers and units, and linked selection. User-selected VS Code themes and renderer settings are authoritative; the dark review screenshots are examples, not a fixed brand palette.

**Key Characteristics:**

- Native workbench controls around focused data surfaces.
- Lattice renderer geometry, settings, and interaction vocabulary.
- Theme-derived color and typography.
- Compact spacing, visible keyboard focus, and explicit source/run state.

## Colors

Color follows the active workbench theme. The frontmatter records live CSS references rather than theme-specific snapshots.

### Primary

The workbench focus color marks keyboard focus and default Network/Diagram selection. The link foreground supplies Monitor cursor and selected-trace color. Chart blue supplies the default Network vertex color. Explicit renderer color settings can override these defaults.

### Neutral

Editor background and foreground unify webviews with their containing editor or panel. Description foreground supports secondary text; panel borders separate rows and plots. Inputs and table hover/selection use their corresponding native semantic tokens.

Diagram blocks default to the editor-widget surface. Block outlines use secondary text; wires, ports, and labels use primary text. High-contrast handling promotes secondary text and separators to foreground where configured. Keep structural edges distinguishable from the canvas.

Warning and error tokens communicate stale documents, validation failures, and execution failures. Pair color with text.

**The Theme Authority Rule.** Resolve native semantic colors at runtime. Do not introduce a second theme switch or freeze the colors of a captured screenshot.

## Typography

Body text inherits the VS Code font family and size. Compact labels, plot headings, and statuses use the label role. Table numbers use the editor font and tabular numerals; other cells retain workbench type.

There is no display-font layer. Labels use sentence case and include units where the catalog supplies them. Plot headings use medium weight. Diagram titles and port names scale with zoom; their sizes are renderer preferences rather than global CSS tokens.

Use stable element identifiers when a name is missing. Editing must expose readable device and port labels; an overview may simplify detail at distant zoom.

## Layout

Network and Diagram occupy native editor groups. Case and Monitor are native bottom-panel views. Inspector, Signals, and Simulation occupy the GridKit sidebar. Users retain normal workbench docking, splitting, and resizing.

The spacing scale follows Lattice's compact rhythm. Table rows use the table-cell height; sticky headers and the identity column preserve context during scrolling. Cells stay on one line, truncate long values, and expose horizontal scrolling. Numeric values align right.

Monitor plots use an automatic grid: columns prefer a minimum width of 420px but shrink to the available panel width; plot rows have a 160px minimum height. One-pixel separators join plots. A compact timeline sits beneath them with a flexible range input and tabular time readout.

Simulation uses a two-column label/control grid with an 8px gap and 12px outer padding. The form scrolls within the sidebar. Renderer canvases fill their surfaces without a separate page container. Layout responds to workbench dimensions, not website device breakpoints.

## Elevation & Depth

Extension surfaces are flat. Borders, background changes, and selection indicate hierarchy; there is no custom card or shadow system. Native menus, Quick Picks, and other overlays retain the workbench's own elevation.

Renderer motion follows its settings: camera and Diagram movement default to 300ms; Monitor axis movement defaults to immediate. System reduced-motion preferences and the explicit accessibility preference suppress motion. Do not add decorative animation.

## Shapes

Inputs have the small control radius in the token layer. Table cells and plot regions form continuous rectangular surfaces.

Diagram block geometry is renderer-owned and configurable. Rounded blocks default to an 8px corner radius in diagram coordinates; ports and arrowheads carry connectivity semantics. Avoid using diagram shapes as decorative containers elsewhere.

## Components

### Native actions and navigation

Place workflow commands in editor/view title actions, contributed context menus, Quick Picks, the Command Palette, and native Settings. Tree rows use native Inspector and Signals affordances. Commands operate on the clicked element, field, or plot. Do not duplicate Run, Stop, plotting, or editing menus in a webview toolbar.

### Case table

Use a real table with sticky column labels, element identities, catalog units, and linked row selection. Cells have quiet hover feedback and an inset visible focus outline. Arrow keys move between cells; F2, Enter, or double-click begins editing. An inline input temporarily replaces the value. Native context menus supply field actions.

### Simulation fields

Use associated labels and native-looking input, select, and checkbox controls. Optional fault fields appear when enabled. Run/Stop remain native title actions. Keep error and run status text adjacent to the form.

### Network and Diagram canvases

Render directly through Latkit using current settings and theme mappings. Selection, hover, focus, and source reveal share element identity with native trees and the Case table. Diagram editing focuses a readable neighborhood and shows full detail; placement and wiring operate on the case document.

### Monitor

Each plot has a compact heading identifying the type, field, and optional element. Axes include domain units and retain space for labels. The timeline supplies scrubbing; native title actions handle playback and stepping. Plot context menus address the selected plot, including its value range. The status identifies the run or imported file and whether data is complete, partial, or following live.

### Status, warnings, and empty states

Use short text within the existing surface. Invalid intermediate source keeps the last valid view visible with an explicit stale warning and paused editing. Recovery and cancellation remain accessible through native commands. Empty states explain what the user can do next without adding a separate application shell.

## Do's and Don'ts

### Do:

- Do resolve color and typography from the current VS Code theme.
- Do preserve native title actions, context menus, trees, Settings, and keyboard focus.
- Do keep identifiers, units, selection, source revision, and run state legible.
- Do use the compact spacing scale and flat separators.
- Do respect renderer preferences, high contrast, and reduced motion.

### Don't:

- Don't copy Lattice's browser shell into a webview.
- Don't hard-code a screenshot's theme as a brand palette.
- Don't duplicate native command surfaces with custom toolbars or menus.
- Don't replace dense engineering views with decorative cards or oversized headings.
- Don't present stale or incomplete data as current and complete.

Implementation sources: `src/webview/theme.css`, `monitor.css`, `Table.svelte`, `Simulation.svelte`, `palette.ts`, renderer option modules, and `src/preferences.ts`. Reviewed workbench captures are in `.impeccable/review/`.

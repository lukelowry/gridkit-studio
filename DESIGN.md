---
name: GridKit Studio
description: Lattice's compact engineering views within the native VS Code workbench.
colors:
  background: 'var(--vscode-editor-background)'
  panel-background: 'var(--vscode-panel-background)'
  sidebar-background: 'var(--vscode-sideBar-background)'
  foreground: 'var(--vscode-foreground)'
  secondary-text: 'var(--vscode-descriptionForeground)'
  divider: 'var(--vscode-panel-border)'
  focus: 'var(--vscode-focusBorder)'
  input-background: 'var(--vscode-input-background)'
  input-foreground: 'var(--vscode-input-foreground)'
  primary: 'var(--vscode-button-background)'
  accent-text: 'var(--vscode-textLink-foreground)'
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
  caption:
    fontFamily: 'var(--vscode-font-family, system-ui)'
    fontSize: '11px'
  numeric:
    fontFamily: 'var(--vscode-editor-font-family, monospace)'
rounded:
  sm: '2px'
  md: '4px'
  lg: '6px'
spacing:
  2xs: '2px'
  xs: '4px'
  sm: '8px'
  md: '12px'
  lg: '16px'
  xl: '24px'
components:
  panel-header:
    height: '32px'
    padding: '0 12px'
  button:
    textColor: '{colors.secondary-text}'
    rounded: '{rounded.lg}'
    height: '28px'
  button-primary:
    backgroundColor: '{colors.primary}'
  icon-button:
    textColor: '{colors.secondary-text}'
    rounded: '{rounded.lg}'
    size: '28px'
  icon-button-pressed:
    backgroundColor: '{colors.row-selection}'
    textColor: '{colors.accent-text}'
  field-input:
    backgroundColor: '{colors.input-background}'
    textColor: '{colors.input-foreground}'
    rounded: '{rounded.md}'
    height: '28px'
  row:
    height: '28px'
  row-hover:
    backgroundColor: '{colors.row-hover}'
  row-selected:
    backgroundColor: '{colors.row-selection}'
---

# Design System: GridKit Studio

## Overview

**Creative North Star: "Lattice in the workbench"**

Studio is Lattice's interface inside VS Code. The workbench owns navigation, documents, menus, settings, and tasks. The views own what Lattice's views own: the canvas, and the controls that belong to it. Those controls are Lattice's components, written against Lattice's tokens, with every color and face read from the workbench theme.

The visual system is restrained and data dense: flat surfaces, narrow separators, readable identifiers and units, and linked selection. User-selected VS Code themes and renderer settings are authoritative; the dark review screenshots are examples, not a fixed brand palette.

**Key Characteristics:**

- Lattice's tokens, components, glyphs, and renderer settings, on the workbench theme.
- Canvas controls in the view; workbench actions in native menus and title bars.
- One playback clock a case, painted by every view of it.
- Compact spacing, visible keyboard focus, and explicit source/run state.

## Tokens

`src/webview/styles/tokens.css` defines Lattice's token names (`--color-*`, `--text-*`, `--spacing-*`, `--radius-*`, `--motion-*`, `--focus-ring`) from workbench theme variables, so a component ported from Lattice keeps its class names and rules. `components.css` carries Lattice's global classes: `c-btn`, `c-icon-btn`, `c-input`, `c-field`, `c-check`, `c-note`, `c-row`, `c-empty`, `c-sr-only`. `src/webview/ui/` holds Lattice's components as they are there: `Select` (searched and windowed past fifty options), `Switch`, `Section`, `Accordion`, `CanvasHost`, `Icon`. Write new view styles against these; do not read `--vscode-*` variables in a component unless no token names the role.

A view sits on the surface of the part of the workbench that holds it: `--color-bg` is the editor background for Network and Diagram, the panel background for Case and Monitor, and the side bar background for Mappings, DynamicSimulation, and Export. Renderers clear with the same token, so a canvas and the chrome around it are one surface.

## Colors

Color follows the active workbench theme. The frontmatter records live CSS references rather than theme-specific snapshots.

### Primary

The workbench focus color marks keyboard focus and the default Network/Diagram hover and selection glow. The link foreground is the accent: the Monitor cursor and selected trace, a pressed control, and a bound field. The button background fills a primary button. Chart blue is the default Network vertex color. Explicit renderer color settings override these defaults.

### Neutral

Secondary text is the description foreground; borders separate rows, lanes, and headers. Inputs use the native input tokens; hover and selection use the native list tokens.

Diagram blocks default to the editor-widget surface. Block outlines use secondary text; wires, ports, and labels use primary text, because many workbench themes give borders too little contrast for structure. Keep structural edges distinguishable from the canvas.

Warning and error tokens communicate stale documents, validation failures, and execution failures. Pair color with text.

**The Theme Authority Rule.** Resolve colors at runtime through the tokens. Do not introduce a second theme switch or freeze the colors of a captured screenshot. Higher contrast, from the theme or the accessibility setting, steps secondary text up to primary, borders up to the contrast border, and thickens the focus ring.

## Typography

Body text inherits the VS Code font family and size. Labels are 12px, captions 11px. Numbers, the playback time, and everything a renderer labels (axes, vertices, blocks, ports) use the editor font, as Lattice labels in mono.

There is no display-font layer. Labels use sentence case and include units where the catalog supplies them, as `name [unit]`. A type and field are named by their catalog labels (`Bus · Voltage magnitude [p.u.]`), not their keys.

Use stable element identifiers when a name is missing. Editing must expose readable device and port labels; an overview may simplify detail at distant zoom.

## Layout

Network and Diagram occupy native editor groups and fill them: zero body padding, no footer. Case and Monitor are native bottom-panel views. Inspector, Mappings, DynamicSimulation, and Export fold in the GridKit sidebar. Users retain normal workbench docking, splitting, and resizing.

A panel header is 32px: what the panel shows where a title would stand, then its controls at the right. Rows are 28px. Settings rows put the label left and the control right, and stack when the panel is narrow (container queries, not device breakpoints).

The Monitor is its header over its lanes. Lanes sit side by side at a 26rem minimum and wrap; a hairline joins them. Each lane is a 28px name row over its plot.

## Elevation & Depth

Surfaces are flat. Borders, background changes, and selection indicate hierarchy; there is no card or shadow system. The one floating element is the view toolbar: a bordered group of icon buttons over the canvas's top right. Native menus and Quick Picks keep the workbench's own elevation.

Renderer motion follows its settings: camera and Diagram movement default to 300ms; Monitor axis movement defaults to immediate. Interface transitions read the motion tokens (80ms and 180ms), which the system preference and the accessibility setting zero. Do not add decorative animation.

## Shapes

Buttons take the large radius, inputs the medium. Table cells, lanes, and plot regions form continuous rectangular surfaces.

Diagram block geometry is renderer-owned and configurable. Rounded blocks default to an 8px corner radius in diagram coordinates; ports and arrowheads carry connectivity semantics. Avoid using diagram shapes as decorative containers elsewhere.

## Components

### What lives where

What Lattice draws in a panel, Studio draws in that panel with Lattice's component: the Network's projection, Auto-rotate and Fit; the Monitor's signal list and playback; the Mappings panel; the DynamicSimulation form with its Run and Stop; video export. A workbench action lives in native surfaces: open, import, export CSV, settings, source, Git, field editing, and context menus on the clicked element. Each has one home. The palette keeps commands for the in-view controls, for keybindings.

### Network and Diagram canvases

Render directly through Latkit using current settings and theme mappings. The toolbar offers each projection only where the case can be seen so, and shows the one on show and Auto-rotate as pressed. Selection, hover, and source reveal share element identity with native trees and the Case table; selecting does not move the camera unless the reader turns that on. A stale source shows the last valid revision under a warning over the canvas; a renderer problem shows as an alert there until the next frame. A lost GPU is replaced once, at the same camera. An edit the case refuses is a native warning.

### Monitor

The header holds the list a signal is added from, the run in a line (name, state, frames), Go live while a run arrives and the playhead is behind it, and the playback controls: step back, play/pause/replay, step forward, the time over the run's end in fixed-width digits, speed, and repeat. Each lane names its signal and has one control, to remove it. Moving the pointer over a paused plot seeks. Space plays or pauses; Page Up and Page Down read traces at the playhead for a screen reader. Zooming one lane zooms all. Plot context menus stay native.

### Mappings

A search field over the drawn types. Each type lists its parameters and its signals in two columns; a field is one button: its label, what it drives in a word (`color, height`) in the accent, and a link glyph. Opening a field shows its editor beneath its type: a checkbox a channel with who drives it now, what Apply would replace or remove in the warning tone, an optional value range, and Cancel/Apply. Nothing changes until Apply.

### Export

A property sheet: Views (switches), Arrangement, Time (start, end, speed), Output (format, resolution, frame rate, quality), then the Export button over a progress bar and one status line. The panel says what blocks an export instead of failing one.

### Case table and DynamicSimulation

A real table with sticky column labels, element identities, catalog units, and linked row selection; F2, Enter, or double-click edits in place.

DynamicSimulation is Lattice's Study panel. A bar reads where the newest run stands (frames, a percentage while it runs, Failed, Stopped) beside Run, which becomes Stop; a hairline under it fills as frames arrive. The parameters follow as rows: numbers in a fixed-width mono field at the right, a choice or an element of the case (a fault's bus) in a Select, a flag as a Switch. A value that cannot run says why under its row and disables Run. Monitors, folded by default, lists each type's recordable signals as switches.

### Status, warnings, and empty states

One short sentence in the existing surface, in the caption color, centered for an empty state. Invalid intermediate source keeps the last valid view visible with an explicit stale warning and paused editing. Empty states say what to do next.

## Do's and Don'ts

### Do:

- Do write views against the tokens and the `c-` classes.
- Do port a Lattice component rather than restyle a native one, for anything coupled to a canvas.
- Do keep identifiers, units, selection, source revision, and run state legible.
- Do respect renderer preferences, high contrast, and reduced motion.

### Don't:

- Don't copy Lattice's shell (header, dock, routing, settings panel, theme switch) into a webview.
- Don't give one action two homes.
- Don't hard-code a screenshot's theme as a brand palette.
- Don't replace dense engineering views with decorative cards or oversized headings.
- Don't present stale or incomplete data as current and complete.

Implementation sources: `src/webview/styles/`, `src/webview/ui/`, the view folders under `src/webview/`, and `src/preferences.ts`. Workbench captures from the host suite are in `output/playwright/`.

import type { Diagram } from '@latkit/diagram'
import type { Layout } from '@latkit/gpu'

import type { SettingsReader } from '../../shared/preferences.js'
import { UNLIMITED } from '../gpu.js'
import { color, gridLine, type Palette, viewStyle } from '../theme.js'

type DiagramStyle = Omit<
  Diagram.Config,
  'source' | 'vertices' | 'edges' | 'groups' | 'canvas' | 'layout' | 'input'
> & { readonly layout: Layout; readonly input: Diagram.Input }

export function layoutOf(s: SettingsReader): Layout {
  return {
    algorithm: s.get('diagram.layout.algorithm'),
    direction: s.get('diagram.layout.direction'),
    vertexGap: s.get('diagram.layout.vertexGap'),
    rankGap: s.get('diagram.layout.rankGap'),
    sweeps: s.get('diagram.layout.sweeps'),
  }
}

/** Diagram settings as renderer options, shared by the live view and video export. */
export function diagramOptions(s: SettingsReader, palette: Palette, font: string): DiagramStyle {
  return {
    ...viewStyle(s, 'diagram', font, {
      background: palette.editor,
      textColor: palette.text1,
      selectedColor: palette.focus,
    }),
    vertexColor: color(s.get('diagram.vertexColor'), palette.surface2),
    outlineColor: color(s.get('diagram.outlineColor'), palette.text2),
    edgeColor: color(s.get('diagram.edgeColor'), palette.text1),
    gridColor: color(s.get('diagram.gridColor'), gridLine(palette)),
    ...(s.get('diagram.groupColor') !== null && {
      groupColor: color(s.get('diagram.groupColor'))!,
    }),
    hoverColor: color(s.get('diagram.hoverColor'), palette.focus),
    grid: s.get('diagram.grid'),
    gridPitch: s.get('diagram.gridPitch'),
    gridMinSpacingPx: s.get('diagram.gridMinSpacingPx'),
    cornerRadius: s.get('diagram.cornerRadius'),
    vertexPadding: s.get('diagram.vertexPadding'),
    outlineWidthPx: s.get('diagram.outlineWidthPx'),
    portLabels: s.get('diagram.portLabels'),
    portMarker: s.get('diagram.portMarker'),
    portSize: s.get('diagram.portSize'),
    portFontSize: s.get('diagram.portFontSize'),
    portSpacing: s.get('diagram.portSpacing'),
    junctions: s.get('diagram.junctions'),
    edgeWidthPx: s.get('diagram.edgeWidthPx'),
    routeClearance: s.get('diagram.routeClearance'),
    labels: s.get('diagram.labels.visible'),
    hoverWidthPx: s.get('diagram.hoverWidthPx'),
    revealPaddingPx: s.get('diagram.revealPaddingPx'),
    detail: s.get('diagram.detail'),
    layout: layoutOf(s),
    input: {
      mode: s.get('diagram.input.mode'),
      wheel: s.get('diagram.input.wheel'),
      keyboard: s.get('diagram.input.keyboard'),
      dragThresholdPx: s.get('diagram.input.dragThresholdPx'),
      touchDragThresholdPx: s.get('diagram.input.touchDragThresholdPx'),
    },
    limits: {
      vertices: UNLIMITED,
      edges: UNLIMITED,
      ends: UNLIMITED,
      geometryBytes: UNLIMITED,
      pickingBytes: UNLIMITED,
      routePoints: UNLIMITED,
      layoutMs: UNLIMITED,
    },
  }
}

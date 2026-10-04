import type { Diagram } from '@latkit/diagram'

import type { SettingsReader } from '../../shared/preferences.js'
import { color, type Palette } from '../theme.js'
/** The same options drive the live view and an export. Null explicitly resets a color or font. */
export function diagramOptions(
  s: SettingsReader,
  palette: Palette | null,
  font: string | null,
): Parameters<Diagram['set']>[0] {
  return {
    motion: s.get('accessibility.motion') === 'reduce' ? 'reduce' : 'auto',
    font: s.get('diagram.font') || font ? { family: s.get('diagram.font') || font! } : null,
    fontSizePx: s.get('diagram.fontSizePx'),
    background: color(s.get('diagram.background'), palette?.background),
    vertexBaseColor: color(s.get('diagram.vertexBaseColor'), palette?.surface2),
    outlineColor: color(s.get('diagram.outlineColor'), palette?.text2),
    textColor: color(s.get('diagram.textColor'), palette?.text1),
    edgeBaseColor: color(s.get('diagram.edgeBaseColor'), palette?.text1),
    gridColor: color(
      s.get('diagram.gridColor'),
      palette ? [palette.text3[0], palette.text3[1], palette.text3[2], 0.15] : null,
    ),
    groupColor: color(s.get('diagram.groupColor')),
    hoverColor: color(s.get('diagram.hoverColor'), palette?.focus),
    selectedColor: color(s.get('diagram.selectedColor'), palette?.focus),
    grid: s.get('diagram.grid'),
    gridPitch: s.get('diagram.gridPitch'),
    gridMinSpacingPx: s.get('diagram.gridMinSpacingPx'),
    cornerRadius: s.get('diagram.cornerRadius'),
    vertexPadding: s.get('diagram.vertexPadding'),
    outlineWidthPx: s.get('diagram.outlineWidthPx'),
    portLabels: s.get('diagram.portLabels'),
    portMarker: s.get('diagram.portMarker'),
    portSizePx: s.get('diagram.portSizePx'),
    portFontSizePx: s.get('diagram.portFontSizePx'),
    portSpacing: s.get('diagram.portSpacing'),
    junctions: s.get('diagram.junctions'),
    edgeWidthPx: s.get('diagram.edgeWidthPx'),
    routeClearance: s.get('diagram.routeClearance'),
    labels: s.get('diagram.labels.visible'),
    hoverWidthPx: s.get('diagram.hoverWidthPx'),
    selectedWidthPx: s.get('diagram.selectedWidthPx'),
    animationMs: s.get('diagram.animationMs'),
    fitPaddingPx: s.get('diagram.fitPaddingPx'),
    revealPaddingPx: s.get('diagram.revealPaddingPx'),
    pickRadiusPx: s.get('diagram.pickRadiusPx'),
    msaa: s.get('diagram.msaa'),
    detail: s.get('diagram.detail'),
    hover: s.get('diagram.hover'),
    hoverBudgetMs: s.get('diagram.hoverBudgetMs'),
    animationMaxVertices: s.get('diagram.animationMaxVertices'),
    layout: {
      algorithm: s.get('diagram.layout.algorithm'),
      direction: s.get('diagram.layout.direction'),
      vertexGap: s.get('diagram.layout.vertexGap'),
      rankGap: s.get('diagram.layout.rankGap'),
      sweeps: s.get('diagram.layout.sweeps'),
    },
    input: {
      mode: s.get('diagram.input.mode'),
      wheel: s.get('diagram.input.wheel'),
      keyboard: s.get('diagram.input.keyboard'),
      dragThresholdPx: s.get('diagram.input.dragThresholdPx'),
      touchDragThresholdPx: s.get('diagram.input.touchDragThresholdPx'),
    },
  }
}

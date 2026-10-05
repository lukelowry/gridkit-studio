/** Network settings as renderer options; the camera stays with the view. */
import type { RGBA } from '@latkit/gpu'
import type { NetworkConfig } from '@latkit/network'

import type { SettingsReader } from '../../shared/preferences.js'
import { color, type Palette } from '../theme.js'

/** Alpha of the hover and selection halos over the theme's focus color. */
const HOVER_ALPHA = 0.5
const SELECTED_ALPHA = 0.82
/** Alpha of borders over the theme's text color. */
const PATH_ALPHA = 0.5

const faded = ([r, g, b, a]: RGBA, alpha: number): RGBA => [r, g, b, a * alpha]

type NetworkStyle = Omit<NetworkConfig, 'source' | 'vertices' | 'edges' | 'paths' | 'canvas'>

export function networkOptions(
  s: SettingsReader,
  palette: Palette,
  font: string,
  geographic: boolean,
): NetworkStyle {
  const family = s.get('network.font') || font
  return {
    markers: s.get('network.markers'),
    poles: s.get('network.poles'),
    grid: s.get('network.grid'),
    earthAxis: s.get('network.earthAxis'),
    vertexRadiusPx: s.get('network.vertexRadiusPx'),
    edgeWidthPx: s.get('network.edgeWidthPx'),
    pathWidthPx: s.get('network.pathWidthPx'),
    zScale: s.get('network.zScale'),
    dashPeriodPx: s.get('network.dashPeriodPx'),
    daylight: s.get('network.daylight') && geographic,
    nightFloor: s.get('network.nightFloor'),
    surfaceNightFloor: s.get('network.surfaceNightFloor'),
    terminatorWidth: s.get('network.terminatorWidth'),
    selectedEnds: s.get('network.selectedEnds'),
    hoverEnds: s.get('network.hoverEnds'),
    hoverWidthPx: s.get('network.hoverWidthPx'),
    selectedWidthPx: s.get('network.selectedWidthPx'),
    fitPitch: s.get('network.fitPitch'),
    fitBearing: s.get('network.fitBearing'),
    orbitRate: s.get('network.orbitRate'),
    animationMs: s.get('network.animationMs'),
    fitPaddingPx: s.get('network.fitPaddingPx'),
    revealPaddingPx: s.get('network.revealPaddingPx'),
    pickRadiusPx: s.get('network.pickRadiusPx'),
    msaa: s.get('network.msaa'),
    hover: s.get('network.hover'),
    hoverBudgetMs: s.get('network.hoverBudgetMs'),
    motion: s.get('accessibility.motion') === 'reduce' ? 'reduce' : 'auto',
    input: {
      mode: s.get('network.input.mode'),
      wheel: s.get('network.input.wheel'),
      keyboard: s.get('network.input.keyboard'),
    },
    ...(family && { font: { family } }),
    fontSizePx: s.get('network.fontSizePx'),
    textColor: color(s.get('network.textColor'), palette.text1),
    background: color(s.get('network.background'), palette.background),
    surfaceColor: color(s.get('network.surfaceColor'), palette.surface2),
    gridColor: color(s.get('network.gridColor'), palette.border),
    hoverColor: color(s.get('network.hoverColor'), faded(palette.focus, HOVER_ALPHA)),
    selectedColor: color(s.get('network.selectedColor'), faded(palette.focus, SELECTED_ALPHA)),
    vertexColor: color(s.get('network.vertexColor'), palette.network),
    edgeColor: color(s.get('network.edgeColor')) ?? 'ends',
    pathColor: color(s.get('network.pathColor'), faded(palette.text2, PATH_ALPHA)),
  }
}

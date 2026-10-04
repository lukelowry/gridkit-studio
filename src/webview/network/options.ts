/** Network preferences translated into one renderer patch; camera state stays with the view. */
import { viewStyle } from '@latkit/gpu'
import type { Network } from '@latkit/network'

import type { SettingsReader } from '../../preferences.js'
import type { Palette } from '../theme.js'
import { color } from '../theme.js'

export function networkOptions(
  s: SettingsReader,
  palette: Palette | null,
  font: string | null,
  geographic: boolean,
): Parameters<Network['set']>[0] {
  const highlight = s.get('network.focusEnabled')
  const ends = s.get('network.focusEnds')
  const hover = color(s.get('network.hoverColor'), palette?.focus) ?? viewStyle.hoverColor
  const selected =
    color(s.get('network.selectedColor'), palette?.focus) ?? viewStyle.selectedColor ?? hover
  return {
    markers: s.get('network.markers'),
    poles: s.get('network.poles'),
    graticule: s.get('network.graticule'),
    earthAxis: s.get('network.earthAxis'),
    vertexRadiusPx: s.get('network.vertexRadiusPx'),
    edgeWidthPx: s.get('network.edgeWidthPx'),
    heightScale: s.get('network.heightScale'),
    dashPeriodPx: s.get('network.dashPeriodPx'),
    daylight: s.get('network.daylight') && geographic,
    nightFloor: s.get('network.nightFloor'),
    surfaceNightFloor: s.get('network.surfaceNightFloor'),
    terminatorWidth: s.get('network.terminatorWidth'),
    selectedEnds: ends !== 'off',
    hoverEnds: ends === 'hover-selected',
    hoverWidthPx: highlight ? s.get('network.hoverWidthPx') : 0,
    selectedWidthPx: highlight ? s.get('network.selectedWidthPx') : 0,
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
    font: s.get('network.font') || font ? { family: s.get('network.font') || font! } : null,
    fontSizePx: s.get('network.fontSizePx'),
    textColor: color(s.get('network.textColor')),
    background: color(s.get('network.background'), palette?.background),
    surfaceColor: color(s.get('network.surfaceColor'), palette?.surface2),
    gridColor: color(s.get('network.gridColor'), palette?.border),
    hoverColor: [hover[0], hover[1], hover[2], highlight ? s.get('network.hoverAlpha') : 0],
    selectedColor: [
      selected[0],
      selected[1],
      selected[2],
      highlight ? s.get('network.selectedAlpha') : 0,
    ],
    vertexBaseColor: color(s.get('network.vertexBaseColor'), palette?.network),
    edgeBaseColor: color(s.get('network.edgeBaseColor')),
  }
}

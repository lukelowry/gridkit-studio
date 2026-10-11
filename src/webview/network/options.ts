/** Network settings as renderer options; the camera stays with the view, and the earth with the
 *  map beneath it. */
import type { Network } from '@latkit/network'

import type { SettingsReader } from '../../shared/preferences.js'
import { UNLIMITED } from '../gpu.js'
import { color, faded, type Palette, viewStyle } from '../theme.js'

/** The strength of the hover and selection glows in the theme's focus color. */
const HOVER_ALPHA = 0.5
const SELECTED_ALPHA = 0.82

type NetworkStyle = Omit<Network.Config, 'source' | 'vertices' | 'edges' | 'canvas'>

export function networkOptions(s: SettingsReader, palette: Palette, font: string): NetworkStyle {
  return {
    ...viewStyle(s, 'network', font, {
      background: palette.background,
      textColor: palette.text1,
      selectedColor: faded(palette.focus, SELECTED_ALPHA),
    }),
    markers: s.get('network.markers'),
    poles: s.get('network.poles'),
    // A laid-out network's own grid; under a map, the map draws it.
    grid: s.get('network.grid'),
    gridColor: color(s.get('network.gridColor'), palette.border),
    vertexRadiusPx: s.get('network.vertexRadiusPx'),
    vertexMinRadiusPx: s.get('network.vertexMinRadiusPx'),
    edgeWidthPx: s.get('network.edgeWidthPx'),
    zScale: s.get('network.zScale'),
    dashPeriodPx: s.get('network.dashPeriodPx'),
    edgeSpacingPx: s.get('network.edgeSpacingPx'),
    shadows: s.get('network.shadows'),
    selectedEnds: s.get('network.selectedEnds'),
    hoverEnds: s.get('network.hoverEnds'),
    hoverScale: s.get('network.hoverScale'),
    hoverWidthPx: s.get('network.hoverWidthPx'),
    fitPitch: s.get('network.fitPitch'),
    fitBearing: s.get('network.fitBearing'),
    orbitRate: s.get('network.orbitRate'),
    revealPaddingPx: s.get('network.revealPaddingPx'),
    input: {
      mode: s.get('network.input.mode'),
      wheel: s.get('network.input.wheel'),
      keyboard: s.get('network.input.keyboard'),
    },
    labelHaloPx: s.get('network.labelHaloPx'),
    hoverColor: color(s.get('network.hoverColor'), faded(palette.focus, HOVER_ALPHA)),
    vertexColor: color(s.get('network.vertexColor'), palette.network),
    edgeColor: color(s.get('network.edgeColor')) ?? 'ends',
    // Hit-test indexes past `pickingBytes` only fall back to scans, so that one stays latkit's.
    limits: {
      vertices: UNLIMITED,
      segments: UNLIMITED,
      geometryBytes: UNLIMITED,
      layoutMs: UNLIMITED,
    },
  }
}

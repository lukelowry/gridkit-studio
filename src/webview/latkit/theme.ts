/** The VS Code theme as latkit reads it, through the CSS tokens. */

import type { Theme as NativeTheme } from 'latkit'

import type { SettingsReader } from '../../shared/settings.js'
import { mix, rgbOf, waterOf } from './color.js'

/** Each color's CSS token, and a fallback for when the theme leaves it unset. */
const PALETTE = {
  background: ['--color-bg', '#1e1e1e'],
  /** The Network's background everywhere, videos included, whatever surface the page is on. */
  editor: ['--vscode-editor-background', '#1e1e1e'],
  text1: ['--color-text-1', '#cccccc'],
  border: ['--color-border', '#444444'],
  /** Faint enough for grid lines in every theme. */
  guide: ['--vscode-editorIndentGuide-background', '#404040'],
  focus: ['--color-focus-ring', '#007fd4'],
  network: ['--color-network', '#cccccc'],
  primaryText: ['--color-primary-text', '#3794ff'],
} as const

type Palette = Readonly<Record<keyof typeof PALETTE, string>>

interface Theme {
  readonly palette: Palette
  readonly font: string
}

/** VS Code's colors, or latkit's own light or dark theme, as the Export view chooses. */
export type ThemeChoice = 'auto' | 'light' | 'dark'

/** The colors a map under the Network is drawn in. */
export interface MapColors {
  /** The earth's ground, under everything else. */
  readonly land: string
  readonly water: string
  /** Boundaries and roads. */
  readonly line: string
  /** Buildings. */
  readonly faint: string
}

/** The Network's theme and the colors of the map under it. */
export interface Look {
  readonly theme: NativeTheme
  readonly map: MapColors
}

/** The ground and text colors of latkit's own themes, which a map takes on in their exports. */
const LATKIT: Record<'light' | 'dark', readonly [land: string, ink: string]> = {
  light: ['#e8ecf0', '#4a5361'],
  dark: ['#18212b', '#a8b2c2'],
}

let current: Theme | undefined
const listeners = new Set<() => void>()
let observer: MutationObserver | undefined

export function theme(): Theme {
  observe()
  if (current) return current
  const css = getComputedStyle(document.body)
  return (current = {
    palette: Object.fromEntries(
      Object.entries(PALETTE).map(([name, [token, fallback]]) => [
        name,
        css.getPropertyValue(token).trim() || fallback,
      ]),
    ) as Palette,
    font: css.getPropertyValue('--font-body').trim(),
  })
}

/** VS Code sets its theme's colors on the document and names the theme on the body. */
function observe() {
  if (observer) return
  observer = new MutationObserver(changed)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'data-vscode-theme-id'],
  })
}

function changed() {
  current = undefined
  for (const listener of listeners) listener()
}

const highContrast = () => {
  const classes = document.body.classList
  return classes.contains('vscode-high-contrast') || classes.contains('vscode-high-contrast-light')
}

export function nativeTheme(
  kind: 'network' | 'monitor',
  choice: ThemeChoice = 'auto',
): Exclude<NativeTheme, string> {
  const { palette, font } = theme()
  if (choice !== 'auto')
    return {
      base: choice,
      ...(kind === 'monitor' && { contrast: 3 }),
      ...(font && { text: { font } }),
      edge: { color: null },
    }
  const classes = document.body.classList
  const contrasted = highContrast()
  return {
    base:
      classes.contains('vscode-light') || classes.contains('vscode-high-contrast-light')
        ? 'light'
        : 'dark',
    // WCAG contrast against the background: enhanced (7:1) in high contrast themes, and the 3:1
    // minimum for graphics in plots.
    ...(contrasted ? { contrast: 7 } : kind === 'monitor' && { contrast: 3 }),
    background: kind === 'monitor' ? palette.background : palette.editor,
    // High contrast borders are too loud for a grid behind the case.
    grid: { color: contrasted ? palette.guide : palette.border },
    text: { color: palette.text1, ...(font && { font }) },
    focus: { selected: palette.focus, hover: palette.primaryText },
    vertex: { color: palette.network },
    // null blends each edge from its endpoints' vertex colors; an edge color mapping overrides it.
    edge: { color: null },
    line: { color: palette.primaryText },
  }
}

/** The Network's theme, and its map's colors worked out from the land and the ink drawn on it:
 *  the editor's background and foreground, or those of latkit's own theme in an export. */
export function networkLook(settings: SettingsReader, choice: ThemeChoice = 'auto'): Look {
  const { palette } = theme()
  const [paper, ink] = choice === 'auto' ? [palette.editor, palette.network] : LATKIT[choice]
  const land = settings.get('map.landColor') ?? paper
  const ground = rgbOf(land) ?? rgbOf(PALETTE.editor[1])!
  const pen = rgbOf(ink) ?? rgbOf(PALETTE.network[1])!
  const map: MapColors = {
    land,
    water: settings.get('map.waterColor') ?? waterOf(ground),
    // Boundaries stand out further in high contrast themes.
    line: mix(ground, pen, choice === 'auto' && highContrast() ? 0.75 : 0.45),
    faint: mix(ground, pen, 0.15),
  }
  return {
    theme: {
      ...nativeTheme('network', choice),
      earth: { ground: map.land, night: settings.get('map.nightBrightness') },
    },
    map,
  }
}

/** Calls `listener` whenever the theme changes; returns the unsubscribe. */
export function watchTheme(listener: () => void): () => void {
  observe()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

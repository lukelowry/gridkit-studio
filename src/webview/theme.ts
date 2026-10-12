/** The VS Code theme as the renderers read it, through the CSS tokens. */

import { type ItemView, parseColor, type RGBA } from '@latkit/gpu'

import type { SettingsReader, SettingsValues } from '../shared/preferences.js'

/** Each renderer color's token, and its color when the theme leaves the token out. */
const PALETTE = {
  background: ['--color-bg', '#1e1e1e'],
  /** The editor's background, which the Network and Diagram sit on wherever they draw, a video's
   *  too, though the page drawing them sits elsewhere. */
  editor: ['--vscode-editor-background', '#1e1e1e'],
  surface1: ['--color-surface-1', '#1e1e1e'],
  surface2: ['--color-surface-2', '#252526'],
  text1: ['--color-text-1', '#cccccc'],
  text2: ['--color-text-2', '#aaaaaa'],
  border: ['--color-border', '#444444'],
  focus: ['--color-focus-ring', '#007fd4'],
  network: ['--color-network', '#cccccc'],
  primaryText: ['--color-primary-text', '#3794ff'],
} as const

export type Palette = Readonly<Record<keyof typeof PALETTE, RGBA>>

/** The theme's colors, and the editor's monospace font family. */
export interface Theme {
  readonly palette: Palette
  readonly font: string
}

let current: Theme | undefined
const listeners = new Set<() => void>()
let observer: MutationObserver | undefined

/** The current theme, read from the tokens once each time it changes. */
export function theme(): Theme {
  observe()
  if (current) return current
  const css = getComputedStyle(document.body)
  return (current = {
    palette: Object.fromEntries(
      Object.entries(PALETTE).map(([name, [token, fallback]]) => [
        name,
        parseColor(css.getPropertyValue(token).trim()) ?? parseColor(fallback)!,
      ]),
    ) as Palette,
    font: css.getPropertyValue('--font-mono').trim(),
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

/** Resolve a saved hex override, or the contextual default; none leaves the renderer's own. */
export function color(value: string | null, fallback: RGBA): RGBA
export function color(value: string | null, fallback?: RGBA): RGBA | undefined
export function color(value: string | null, fallback?: RGBA): RGBA | undefined {
  return value === null ? fallback : (parseColor(value) ?? fallback)
}

/** `color` with its alpha scaled by `alpha`. */
export const faded = ([r, g, b, a]: RGBA, alpha: number): RGBA => [r, g, b, a * alpha]

/** `from` moved `t` of the way toward `to`, keeping its alpha. */
export const mix = (from: RGBA, to: RGBA, t: number): RGBA => [
  from[0] + (to[0] - from[0]) * t,
  from[1] + (to[1] - from[1]) * t,
  from[2] + (to[2] - from[2]) * t,
  from[3],
]

/** The style every latkit view shares, from one view's settings: quality, motion, picking, text
 *  and colors, with `fallback`'s theme colors where a color setting is null. */
export function viewStyle(
  s: SettingsReader,
  view: 'network' | 'diagram' | 'monitor',
  font: string | null,
  fallback: {
    readonly background?: RGBA
    readonly textColor?: RGBA
    readonly selectedColor?: RGBA
  },
): ItemView.Style {
  const motion = s.get('accessibility.motion')
  const family = s.get(`${view}.font`) || font
  return {
    msaa: s.get(`${view}.msaa`),
    hover: s.get(`${view}.hover`),
    hoverBudgetMs: s.get(`${view}.hoverBudgetMs`),
    pickRadiusPx: s.get(`${view}.pickRadiusPx`),
    animationMs: s.get(`${view}.animationMs`),
    fitPaddingPx: s.get(`${view}.fitPaddingPx`),
    selectedWidthPx: s.get(`${view}.selectedWidthPx`),
    motion: motion === 'system' ? 'auto' : motion,
    ...(family && { font: { family } }),
    fontSizePx: s.get(`${view}.fontSizePx`),
    background: color(s.get(`${view}.background`), fallback.background),
    textColor: color(s.get(`${view}.textColor`), fallback.textColor),
    selectedColor: color(s.get(`${view}.selectedColor`), fallback.selectedColor),
  }
}

/** Expose the user's motion and contrast settings to the tokens. Another contrast changes the
 *  theme's colors, which the watchers hear at once. */
export function appearance(settings: SettingsValues | undefined) {
  const { dataset } = document.body
  dataset.motion = settings?.['accessibility.motion'] ?? 'system'
  const contrast = settings?.['accessibility.contrast'] ?? 'system'
  if (dataset.contrast === contrast) return
  dataset.contrast = contrast
  changed()
}

/** Calls `listener` whenever the theme changes; returns the unsubscribe. */
export function watchTheme(listener: () => void): () => void {
  observe()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

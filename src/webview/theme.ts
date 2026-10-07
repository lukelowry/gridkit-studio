/** The VS Code theme as the renderers read it, through the CSS tokens. */

import { parseColor, type RGBA } from '@latkit/gpu'

import type { SettingsValues } from '../shared/preferences.js'

/** Each renderer color's token, and its color when the theme leaves the token out. */
const PALETTE = {
  background: ['--color-bg', '#1e1e1e'],
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

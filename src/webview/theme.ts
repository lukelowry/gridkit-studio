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

/** The current theme's colors. */
export function palette(): Palette {
  const css = getComputedStyle(document.body)
  return Object.fromEntries(
    Object.entries(PALETTE).map(([name, [token, fallback]]) => [
      name,
      parseColor(css.getPropertyValue(token).trim()) ?? parseColor(fallback)!,
    ]),
  ) as Palette
}

/** The editor's monospace font family. */
export function font(): string {
  return getComputedStyle(document.body).getPropertyValue('--font-mono').trim()
}

/** Resolve a saved hex override, or the contextual default; null leaves the renderer's own. */
export function color(value: string | null, fallback: RGBA): RGBA
export function color(value: string | null, fallback?: RGBA | null): RGBA | null
export function color(value: string | null, fallback: RGBA | null = null): RGBA | null {
  return value === null ? fallback : (parseColor(value) ?? fallback)
}

/** Expose the user's motion and contrast settings to the tokens. */
export function appearance(settings: SettingsValues | undefined) {
  document.body.dataset.contrast = settings?.['accessibility.contrast'] ?? 'system'
  document.body.dataset.motion = settings?.['accessibility.motion'] ?? 'system'
}

/** Calls `changed` whenever the VS Code theme changes; returns the unsubscribe. */
export function watchTheme(changed: () => void): () => void {
  const observer = new MutationObserver(changed)
  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] })
  return () => observer.disconnect()
}

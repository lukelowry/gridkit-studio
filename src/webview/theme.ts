/** The workbench theme as the renderers draw with it, read through the tokens. */

import { parseColor, type RGBA } from '@latkit/gpu'

import type { SettingsValues } from '../preferences.js'

/** The token each renderer color is read from, and the color when a theme leaves it out. */
const PALETTE = {
  background: ['--color-bg', '#1e1e1e'],
  surface1: ['--color-surface-1', '#1e1e1e'],
  surface2: ['--color-surface-2', '#252526'],
  text1: ['--color-text-1', '#cccccc'],
  text2: ['--color-text-2', '#aaaaaa'],
  text3: ['--color-text-3', '#aaaaaa'],
  border: ['--color-border', '#444444'],
  focus: ['--color-focus-ring', '#007fd4'],
  network: ['--color-network', '#75beff'],
  primaryText: ['--color-primary-text', '#3794ff'],
} as const

/** The theme's colors the renderers draw with. */
export type Palette = Readonly<Record<keyof typeof PALETTE, RGBA>>

/** The colors of the theme in force, on the surface this view sits on. */
export function palette(): Palette {
  const css = getComputedStyle(document.body)
  return Object.fromEntries(
    Object.entries(PALETTE).map(([name, [token, fallback]]) => [
      name,
      parseColor(css.getPropertyValue(token).trim()) ?? parseColor(fallback)!,
    ]),
  ) as Palette
}

/** The face the renderers label with: the editor's. */
export function font(): string {
  return getComputedStyle(document.body).getPropertyValue('--font-mono').trim()
}

/** Resolve a saved hex override, or reset the renderer to its contextual default. */
export function color(value: string | null, fallback: RGBA | null = null): RGBA | null {
  return value === null ? fallback : (parseColor(value) ?? fallback)
}

/** Put the reader's motion and contrast choices where the tokens answer them. */
export function appearance(settings: SettingsValues | undefined) {
  document.body.dataset.contrast = settings?.['accessibility.contrast'] ?? 'system'
  document.body.dataset.motion = settings?.['accessibility.motion'] ?? 'system'
}

/** Call `changed` whenever the workbench theme does; returns the stop. */
export function watchTheme(changed: () => void): () => void {
  const observer = new MutationObserver(changed)
  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] })
  return () => observer.disconnect()
}

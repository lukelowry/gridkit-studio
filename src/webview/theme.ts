/** The VS Code theme as the renderers read it, through the CSS tokens. */

import type { Theme as NativeTheme } from 'latkit'

import type { SettingsReader } from '../shared/preferences.js'

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

export type Palette = Readonly<Record<keyof typeof PALETTE, string>>

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
        css.getPropertyValue(token).trim() || fallback,
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

/** VS Code colors feed native theme properties directly. */
export function nativeTheme(
  settings: SettingsReader,
  kind: 'network' | 'diagram' | 'monitor',
): NativeTheme {
  const { palette } = theme()
  return {
    base:
      document.body.classList.contains('vscode-light') ||
      document.body.classList.contains('vscode-high-contrast-light')
        ? 'light'
        : 'dark',
    background: kind === 'monitor' ? palette.background : palette.editor,
    grid: palette.border,
    text: { color: palette.text1 },
    focus: { selected: palette.focus, hover: palette.primaryText },
    vertex: { color: palette.network },
    edge: { color: palette.text2 },
    line: { color: palette.primaryText },
    earth: {
      ground: settings.get('network.map.ground') ?? palette.editor,
      night: settings.get('network.map.night'),
    },
  }
}

/** Calls `listener` whenever the theme changes; returns the unsubscribe. */
export function watchTheme(listener: () => void): () => void {
  observe()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

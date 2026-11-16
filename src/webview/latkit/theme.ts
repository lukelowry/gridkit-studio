/** The VS Code theme as latkit reads it, through the CSS tokens. */

import type { Theme as NativeTheme } from 'latkit'

import type { SettingsReader } from '../../shared/settings.js'

/** Each color's CSS token, and a fallback for when the theme leaves it unset. */
const PALETTE = {
  background: ['--color-bg', '#1e1e1e'],
  /** The Network's background everywhere, videos included, whatever surface the page is on. */
  editor: ['--vscode-editor-background', '#1e1e1e'],
  surface2: ['--color-surface-2', '#252526'],
  text1: ['--color-text-1', '#cccccc'],
  text2: ['--color-text-2', '#aaaaaa'],
  border: ['--color-border', '#444444'],
  /** Faint enough for grid lines in every theme. */
  guide: ['--vscode-editorIndentGuide-background', '#404040'],
  focus: ['--color-focus-ring', '#007fd4'],
  network: ['--color-network', '#cccccc'],
  primaryText: ['--color-primary-text', '#3794ff'],
} as const

export type Palette = Readonly<Record<keyof typeof PALETTE, string>>

interface Theme {
  readonly palette: Palette
  readonly font: string
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

export function nativeTheme(settings: SettingsReader, kind: 'network' | 'monitor'): NativeTheme {
  const { palette, font } = theme()
  const classes = document.body.classList
  const highContrast =
    classes.contains('vscode-high-contrast') || classes.contains('vscode-high-contrast-light')
  return {
    base:
      classes.contains('vscode-light') || classes.contains('vscode-high-contrast-light')
        ? 'light'
        : 'dark',
    // WCAG contrast against the background: enhanced (7:1) in high contrast themes, and the 3:1
    // minimum for graphics in plots.
    ...(highContrast ? { contrast: 7 } : kind === 'monitor' && { contrast: 3 }),
    background: kind === 'monitor' ? palette.background : palette.editor,
    // High contrast borders are too loud for a grid behind the case.
    grid: highContrast ? palette.guide : palette.border,
    text: { color: palette.text1, ...(font && { font }) },
    focus: { selected: palette.focus, hover: palette.primaryText },
    vertex: { color: palette.network },
    // null blends each edge from its endpoints' vertex colors; an edge color mapping overrides it.
    edge: { color: null },
    line: { color: palette.primaryText },
    earth: {
      ground: settings.get('network.map.groundColor') ?? palette.editor,
      night: settings.get('network.map.nightBrightness'),
    },
  }
}

/** Calls `listener` whenever the theme changes; returns the unsubscribe. */
export function watchTheme(listener: () => void): () => void {
  observe()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

import { parseColor, type RGBA } from '@latkit/gpu'
export interface Palette {
  background: RGBA
  surface1: RGBA
  surface2: RGBA
  text1: RGBA
  text2: RGBA
  text3: RGBA
  border: RGBA
  focus: RGBA
  network: RGBA
  primaryText: RGBA
}
/** Lattice semantic palette, resolved from the workbench rather than a second theme switch. */
export function palette(): Palette {
  const css = getComputedStyle(document.body)
  const token = (name: string, fallback: string): RGBA =>
    parseColor(css.getPropertyValue('--vscode-' + name).trim() || fallback)!
  return {
    background: token('editor-background', '#1e1e1e'),
    surface1: token(
      'panel-background',
      css.getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e',
    ),
    surface2: token('editorWidget-background', '#252526'),
    text1: token('foreground', '#cccccc'),
    text2: token(
      document.body.dataset.contrast === 'high' ? 'foreground' : 'descriptionForeground',
      '#aaaaaa',
    ),
    text3: token(
      document.body.dataset.contrast === 'high' ? 'foreground' : 'descriptionForeground',
      '#aaaaaa',
    ),
    border: token(
      'contrastBorder',
      css.getPropertyValue('--vscode-panel-border').trim() || '#444444',
    ),
    focus: token('focusBorder', '#007fd4'),
    network: token('charts-blue', '#75beff'),
    primaryText: token('textLink-foreground', '#3794ff'),
  }
}
export function font(): string {
  return getComputedStyle(document.body).fontFamily
}
export function color(value: string | null, fallback: RGBA | null = null): RGBA | null {
  return value === null ? fallback : (parseColor(value) ?? fallback)
}

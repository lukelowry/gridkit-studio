/** Icon glyphs on a 16-unit grid, drawn with one shared stroke. */

/** Path data, or a circle as `[cx, cy, r]`. */
type Shape = string | readonly [cx: number, cy: number, r: number]

const GLYPHS = {
  close: ['M4 4l8 8M12 4l-8 8'],
  chevron: ['M4 6.5 8 10.5 12 6.5'],
  check: ['m3 8 3 3 7-7'],

  // Network view controls.
  'projection-flat': ['M2.5 4.5h11v7h-11z', 'M5.25 4.5v7M10.75 4.5v7M2.5 8h11'],
  'projection-tilt': ['M5.5 4.5h5l3 7h-11z', 'M8 4.5v7M4 8h8'],
  'projection-globe': [
    [8, 8, 5.5],
    'M2.75 8h10.5M8 2.5c1.65 1.45 2.5 3.25 2.5 5.5S9.65 12.05 8 13.5',
    'M8 2.5C6.35 3.95 5.5 5.75 5.5 8s.85 4.05 2.5 5.5',
  ],
  orbit: [
    'M8 2.5v3.5M8 10.25v3.25',
    'M13.75 8.25A5.75 2 0 1 1 11.6 6.7',
    'M10.6 5.6 11.6 6.7 10.1 7.15',
  ],
} satisfies Record<string, readonly Shape[]>

export type IconName = keyof typeof GLYPHS

/** The glyph as SVG markup, hidden from assistive technology: its control carries the name. */
export function icon(name: IconName): string {
  const shapes = GLYPHS[name]
    .map((shape) =>
      typeof shape === 'string'
        ? `<path d="${shape}"/>`
        : `<circle cx="${shape[0]}" cy="${shape[1]}" r="${shape[2]}"/>`,
    )
    .join('')
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes}</svg>`
}

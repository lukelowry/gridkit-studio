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

  // Playback.
  play: ['M5 3.5v9l7.5-4.5z'],
  pause: ['M5.5 3.5v9M10.5 3.5v9'],
  stop: ['M4.5 4.5h7v7h-7z'],
  'play-once': ['M4 3.5v9l6-4.5zM12 3.5v9'],
  replay: ['M3.5 8.5A4.5 4.5 0 1 0 4.8 5', 'M3.25 2.75v2.75H6'],
  repeat: ['M3 5.5h8.5l-2-2M13 10.5H4.5l2 2', 'M11.5 5.5 13 7M4.5 10.5 3 9'],
  bounce: ['M3 5.5h7.5l-2-2M13 10.5H5.5l2 2', 'M10.5 5.5 12 7M5.5 10.5 4 9'],
  'step-back': ['M4 3.5v9', 'M12 3.5 6 8l6 4.5z'],
  'step-forward': ['M12 3.5v9', 'M4 3.5 10 8l-6 4.5z'],

  // Binds a field to a display channel.
  link: [
    'M6.25 10.25 5 11.5a2.5 2.5 0 0 1-3.5-3.5L4 5.5A2.5 2.5 0 0 1 7.5 5',
    'M9.75 5.75 11 4.5a2.5 2.5 0 0 1 3.5 3.5L12 10.5a2.5 2.5 0 0 1-3.5.5',
    'm5.5 10.5 5-5',
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

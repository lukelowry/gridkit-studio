/** Icon glyphs on a 16-unit grid, drawn with one shared stroke. */

type Shape = string | readonly [cx: number, cy: number, r: number]

const GLYPHS = {
  close: ['M4 4l8 8M12 4l-8 8'],
  /** A monitor: a trace over time. */
  graph: ['M2.5 2.5v11h11', 'M4.5 10.5l2.5-3.5 2.5 2 3.5-5'],
  split: ['M2.5 3.5h11v9h-11z', 'M8 3.5v9'],
  /** Mapped onto the Network. */
  mapped: ['M8 2.75c2.4 2.9 3.75 4.95 3.75 6.75a3.75 3.75 0 0 1-7.5 0c0-1.8 1.35-3.85 3.75-6.75z'],

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

/** SVG markup, hidden from assistive technology since its control carries the name. */
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

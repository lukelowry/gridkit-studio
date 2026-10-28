import { Data, type Mark, Tiles } from 'latkit'

import type { Palette } from './theme.js'

export async function borderMaps(
  base: URL,
  palette: Palette,
  signal: AbortSignal,
): Promise<{ data: Data[]; marks: Mark[] }> {
  const results = await Promise.allSettled(
    ['provinces', 'countries', 'coastline'].map((name) =>
      Data.read(new URL(`maps/${name}.geojson.gz`, base).href, { name: `map:${name}`, signal }),
    ),
  )
  const failure = results.find((result) => result.status === 'rejected')
  if (failure || signal.aborted) {
    for (const result of results) if (result.status === 'fulfilled') result.value.destroy()
    if (failure) throw failure.reason
    signal.throwIfAborted()
  }
  const data = results.map((result) => {
    if (result.status !== 'fulfilled') throw new Error('Map loading failed.')
    return result.value
  })
  return {
    data,
    marks: data.map((source, index): Mark => ({
      lines: [source.name, 'lines'],
      name: source.name,
      geometry: 'geometry',
      color: palette.text2,
      width: index === 0 ? 0.6 : 1,
      dash: index === 0,
      pick: false,
      select: false,
    })),
  }
}

export function streetMaps(url: string, palette: Palette): { source: Tiles; marks: Mark[] } {
  const source = new Tiles('map:streets', url)
  return {
    source,
    marks: [
      ...['landcover', 'park', 'water', 'building'].map((table): Mark => ({
        areas: [source.name, table],
        color: table === 'water' ? palette.background : palette.surface2,
        pick: false,
        select: false,
      })),
      {
        lines: [source.name, 'transportation'],
        color: palette.text2,
        width: 0.7,
        pick: false,
        select: false,
      },
      {
        lines: [source.name, 'boundary'],
        color: palette.text2,
        dash: true,
        pick: false,
        select: false,
      },
    ],
  }
}

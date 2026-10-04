/** Immutable Natural Earth boundaries in longitude/latitude. Public-domain source; regenerate with pnpm borders. */

import { createData, type Data, type RowBatch, type Schema, textColumn } from '@latkit/model'

/** The kinds of border, by the type the network draws each as. */
export const BORDERS = ['Coast', 'Country', 'Province'] as const
export type Border = (typeof BORDERS)[number]

/** One kind's lines: where each starts among its points, which run longitude, latitude. */
interface Lines {
  readonly starts: Uint32Array
  readonly points: Float32Array
}

const FILE = new URL(
  './borders.bin',
  document.querySelector<HTMLScriptElement>('script[type=module]')!.src,
)
const VERSION = 'natural-earth-5.1.2'
/** Each kind of border: its lines, each a list of longitude, latitude points. */
const KIND = {
  fields: {
    points: { type: { kind: 'list', items: { kind: 'vector', items: 'float32', size: 2 } } },
  },
  spatial: { field: 'points', system: 'geographic' },
} as const
const SCHEMA: Schema = { types: Object.fromEntries(BORDERS.map((type) => [type, KIND])) }
let loading: Promise<Data> | null = null

/** The borders, fetched with the page's assets the first time they are asked for; a failed fetch is
 *  tried again the next time. */
export function loadBorders(): Promise<Data> {
  loading ??= fetch(FILE)
    .then(async (response) => {
      if (!response.ok) throw new Error(`The borders could not be read (${response.status}).`)
      return bordersOf(await response.arrayBuffer())
    })
    .catch((error: unknown) => {
      loading = null
      throw error
    })
  return loading
}

/** The borders `bytes` hold, as `pnpm borders` writes them. */
export function bordersOf(bytes: ArrayBuffer): Data {
  const length = new DataView(bytes).getUint32(0, true)
  const { layers } = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 4, length))) as {
    readonly layers: readonly {
      readonly type: string
      readonly lines: number
      readonly points: number
    }[]
  }
  let at = 4 + length
  const starts = layers.map(({ lines }) => {
    const view = new Uint32Array(bytes, at, lines + 1)
    at += view.byteLength
    return view
  })
  const points = layers.map((layer) => {
    const view = new Float32Array(bytes, at, layer.points * 2)
    at += view.byteLength
    return view
  })
  if (at !== bytes.byteLength) throw new Error('The borders file is not whole.')
  const kinds = Object.fromEntries(
    layers.map(({ type }, k) => [type, { starts: starts[k]!, points: points[k]! }]),
  )
  for (const border of BORDERS)
    if (!(border in kinds)) throw new Error(`The borders file has no ${border} lines.`)
  return createData(
    SCHEMA,
    BORDERS.map((type) => linesOf(type, kinds[type]!)),
  )
}

/** One kind's lines as rows: a line per row, its points a list of longitude, latitude. */
function linesOf(type: Border, { starts, points }: Lines): RowBatch {
  const count = starts.length - 1
  return {
    kind: 'rows',
    index: { source: 'studio:borders', type, version: VERSION },
    rows: { kind: 'range', offset: 0, count },
    ids: textColumn(Array.from({ length: count }, (_, row) => `${type}/${row}`)),
    columns: {
      points: {
        kind: 'list',
        offset: 0,
        length: count,
        offsets: new Int32Array(starts.buffer, starts.byteOffset, starts.length),
        values: {
          kind: 'vector',
          size: 2,
          offset: 0,
          length: points.length / 2,
          values: { kind: 'numeric', values: points, offset: 0, length: points.length },
        },
      },
    },
  }
}

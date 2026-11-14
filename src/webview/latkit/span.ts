/** How far across a case lies, which scales the heights its Network maps. */

import { type Data, field, type Id } from 'latkit'

import type { Drawing } from '../../shared/document.js'

/** The distance the stress layout keeps between linked vertices, in plane units: latkit's own
 *  default, named so a case's span on a plane is known. */
export const GAP = 40

/** Each revision of a case's data is a Data of its own, so a span is measured once per revision. */
const spans = new WeakMap<Data, number>()

/** How far across a case's vertices lie, in the units its space places them in. On the earth: the
 *  diagonal of the box their positions fill, in degrees of arc, as elevations are. On a plane: the
 *  most links between two of them times the gap the stress layout keeps between linked vertices,
 *  since it draws graph distances as distances. */
export function caseSpan(data: Data, drawing: Drawing): number {
  let span = spans.get(data)
  if (span === undefined) {
    const held = new Set(data.describe().tables.map((table) => table.name))
    span = drawing.geographic
      ? diagonal(data, drawing, held)
      : GAP * linksAcross(data, drawing, held)
    spans.set(data, span)
  }
  return span
}

function diagonal(data: Data, drawing: Drawing, held: ReadonlySet<string>): number {
  let [west, east, south, north] = [Infinity, -Infinity, Infinity, -Infinity]
  for (const { table, position } of drawing.vertices) {
    if (!held.has(table)) continue
    const { fields } = data.query({
      of: table,
      select: { x: field(position[0]), y: field(position[1]) },
    })
    const [xs, ys] = [fields.x as Float64Array, fields.y as Float64Array]
    for (let row = 0; row < xs.length; row++) {
      const [x, y] = [xs[row]!, ys[row]!]
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      if (x < west) west = x
      if (x > east) east = x
      if (y < south) south = y
      if (y > north) north = y
    }
  }
  if (!(east >= west)) return 0
  // A degree of longitude is a degree of arc times the cosine of the latitude.
  const across = (east - west) * Math.cos((((north + south) / 2) * Math.PI) / 180)
  return Math.hypot(across, north - south)
}

function linksAcross(data: Data, drawing: Drawing, held: ReadonlySet<string>): number {
  // Every vertex by its place, table by table.
  const places = new Map<string, Map<Id, number>>()
  let count = 0
  for (const { table } of drawing.vertices) {
    if (!held.has(table) || places.has(table)) continue
    const place = new Map<Id, number>()
    for (const id of data.query({ of: table, select: {} }).ids) place.set(id, count++)
    places.set(table, place)
  }
  // Every link between two places, both ways.
  const from: number[] = []
  const to: number[] = []
  for (const { table, ends } of drawing.edges) {
    if (!ends || !held.has(table)) continue
    const { fields } = data.query({ of: table, select: { a: field(ends[0]), b: field(ends[1]) } })
    const [a, b] = [fields.a, fields.b] as { reference: string; ids: (Id | null)[] }[]
    const [first, second] = [places.get(a!.reference), places.get(b!.reference)]
    if (!first || !second) continue
    for (let row = 0; row < a!.ids.length; row++) {
      const [one, other] = [a!.ids[row], b!.ids[row]]
      const p = one === null || one === undefined ? undefined : first.get(one)
      const q = other === null || other === undefined ? undefined : second.get(other)
      if (p === undefined || q === undefined || p === q) continue
      from.push(p, q)
      to.push(q, p)
    }
  }
  // Each place's links in one array, as offsets into it.
  const offsets = new Int32Array(count + 1)
  for (const p of from) offsets[p + 1]!++
  for (let p = 0; p < count; p++) offsets[p + 1]! += offsets[p]!
  const linked = new Int32Array(from.length)
  const filled = offsets.slice(0, count)
  for (let i = 0; i < from.length; i++) linked[filled[from[i]!]!++] = to[i]!
  const links = new Int32Array(count).fill(-1)
  const queue = new Int32Array(count)
  /** Breadth first from `start`: how many places it reaches, the farthest last in `queue`. */
  const sweep = (start: number): number => {
    let reached = 1
    queue[0] = start
    links[start] = 0
    for (let at = 0; at < reached; at++) {
      const place = queue[at]!
      for (let i = offsets[place]!; i < offsets[place + 1]!; i++) {
        const next = linked[i]!
        if (links[next] !== -1) continue
        links[next] = links[place]! + 1
        queue[reached++] = next
      }
    }
    return reached
  }
  const forget = (reached: number) => {
    for (let at = 0; at < reached; at++) links[queue[at]!] = -1
  }
  // In each island, the place farthest from any, then the farthest from that: the most links
  // between two of its places, or close to it.
  const seen = new Uint8Array(count)
  let most = 0
  for (let start = 0; start < count; start++) {
    if (seen[start]) continue
    let reached = sweep(start)
    for (let at = 0; at < reached; at++) seen[queue[at]!] = 1
    const far = queue[reached - 1]!
    forget(reached)
    reached = sweep(far)
    most = Math.max(most, links[queue[reached - 1]!]!)
    forget(reached)
  }
  return Math.max(1, most)
}

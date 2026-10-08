/** A run's pages: the unit the worker decodes, the extension streams and a view holds. */

import type { Domain, FieldSelection } from '@latkit/model'

import { pageWindow } from './coverage.js'

/** Frames `first` up to `first + count` of a run, at times `domain`. A published page never
 *  changes. */
export interface PageEntry {
  readonly first: number
  readonly count: number
  readonly domain: Domain
}

/** A page a view lacks, and the fields it lacks there, each a selection of one field. */
export interface Want {
  readonly page: number
  readonly fields: readonly FieldSelection[]
}

/** Pages `first` up to `end`. */
export type PageRange = readonly [number, number]

/** While a playhead plays, time behind it counts this many times over: it loads mostly ahead. */
const BEHIND = 4

/** The page holding `at`: the last that starts at or before it, else the first. */
export function pageAt(pages: readonly PageEntry[], at: number): number {
  let low = 0
  let high = pages.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (pages[middle]!.domain[0] <= at) low = middle + 1
    else high = middle
  }
  return Math.max(0, low - 1)
}

/** The pages a moment needs to be covered: its own, and the next when it falls after its own page's
 *  last sample, as coverage reaches only from one sample held to the next. */
export function pagesAt(pages: readonly PageEntry[], at: number): PageRange {
  if (!pages.length) return [0, 0]
  const own = pageAt(pages, at)
  return [own, at > pages[own]!.domain[1] && own + 1 < pages.length ? own + 2 : own + 1]
}

/** The pages a span needs: those overlapping it, and one either side, for the sample before it and
 *  the lines that cross its ends. */
export function pagesOver(pages: readonly PageEntry[], span: Domain): PageRange {
  return pageWindow(pages, span)
}

/** The page holding frame `frame`. */
export function pageOf(pages: readonly PageEntry[], frame: number): number {
  let low = 0
  let high = pages.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (pages[middle]!.first <= frame) low = middle + 1
    else high = middle
  }
  return low - 1
}

/** The pages outside `range`, nearest `at` first: whichever of the next later and the next earlier
 *  page starts nearer. Time behind a playhead playing at `travel` counts BEHIND times over. */
export function* around(
  pages: readonly PageEntry[],
  [first, end]: PageRange,
  at: number,
  travel = 0,
): Generator<number> {
  let later = end
  let earlier = first - 1
  while (later < pages.length || earlier >= 0) {
    const ahead =
      later < pages.length
        ? Math.max(0, pages[later]!.domain[0] - at) * (travel < 0 ? BEHIND : 1)
        : Infinity
    const behind =
      earlier >= 0
        ? Math.max(0, at - pages[earlier]!.domain[1]) * (travel > 0 ? BEHIND : 1)
        : Infinity
    if (ahead <= behind) yield later++
    else yield earlier--
  }
}

/** What names a selection of fields and rows, so equal selections compare equal. */
export function selectionKey({ from, select, rows }: FieldSelection): string {
  return `${from}\n${select.join(',')}\n${rows ? JSON.stringify(rows) : ''}`
}

/** What names one selection on one page. */
export function wantKey(page: number, selection: FieldSelection): string {
  return `${page}\n${selectionKey(selection)}`
}

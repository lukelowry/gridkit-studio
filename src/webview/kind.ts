/** What the Network and the Diagram each bring to the canvas they share, and what the canvas offers
 *  them. */

import type { Diagram } from '@latkit/diagram'
import type { Gpu } from '@latkit/gpu'
import type { Query } from '@latkit/model'
import type { Network } from '@latkit/network'

import type { Bindings } from '../shared/bindings.js'
import type { Element, Summary, ViewState } from '../shared/messages.js'
import type { Snapshot } from './rows.js'

/** A view on the canvas. */
export type Drawn = Network | Diagram

/** What the canvas offers the kind of view it holds. */
export interface Host {
  /** The canvas's host element, and the canvas itself. */
  readonly element: HTMLElement
  readonly canvas: HTMLCanvasElement
  /** The state last sent, the rows held, and the view mounted. */
  state(): ViewState
  rows(): Snapshot | undefined
  view(): Drawn | undefined
  /** Whether VS Code shows the view, whether it has drawn a frame, and whether its page is gone. */
  shown(): boolean
  rendered(): boolean
  closed(): boolean
  /** Counts what has come to draw: rows or samples. */
  received(): void
  /** Mounts the view if it has none, and draws. */
  render(): void
  /** Gives the view its whole config next frame, or now. */
  paint(): void
  paintNow(): void
  /** Lets go of the view, to draw another. */
  drop(): void
  /** Stops waiting: there is nothing to draw. */
  settle(): void
  /** What the view says while it loads. */
  waiting(text: string): void
  select(element: Element | null): void
  open(element: Element): void
  mark(name: string): void
}

/** What the Network or the Diagram brings to the canvas they share. */
export interface Kind {
  /** Its renderer, loading while the worker prepares the case. */
  readonly loaded: Promise<void>
  /** Whether it asks where the diagram's blocks are arranged. */
  readonly presentation: boolean
  /** The static fields of the case it draws. */
  needs(summary: Summary, bindings: Bindings | undefined): Query.Selection[]
  /** Whether `rows` are of the case it draws now. */
  current(rows: Snapshot | undefined): boolean
  /** Whether it can draw now; it asks for what it lacks. */
  ready(): boolean
  /** Readies it to draw `rows` once its renderer has loaded: false when it cannot draw them yet,
   *  or has nothing to draw. */
  arrange(rows: Snapshot): boolean
  /** The view on the canvas, drawing `rows`. */
  mount(gpu: Gpu, rows: Snapshot): Drawn
  /** Gives `view` its whole config of `rows`; it keeps what it has read, scaled, laid out and
   *  uploaded for every value that did not change. */
  paint(view: Drawn, rows: Snapshot): void
  /** What follows a paint once it is applied. */
  painted(view: Drawn): void
  /** Once the view's first frame is on screen. */
  presented(view: Drawn): void
  /** Lets go of what it made with the view, once the view is destroyed. */
  unmount(): void
  /** The item `view` draws for `element`; undefined when it draws none. */
  item(view: Drawn, element: Element): unknown
  /** Brings its own controls up to date with the view. */
  sync(): void
  /** A command of the extension's that only it answers. */
  act(view: Drawn, command: string, value: unknown): void
  /** Asks again for what failed, as a reload does. */
  retry(): void
  /** What tests, and a report of a failure, read of it. */
  stats(): Record<string, unknown>
  dispose(): void
}

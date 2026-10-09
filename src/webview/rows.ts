/** The case's rows a view draws, asked of the workers a few fields at a time: the static fields it
 *  lacks of the revision it shows. A field asked for stays held while the revision stands, so a
 *  mapping taken away changes nothing drawn, and mapping it again asks for nothing. */

import type { Positions } from '@latkit/gpu'
import {
  createData,
  type Data,
  type FieldSelection,
  type RowBatch,
  type Schema,
  staticFields,
} from '@latkit/model'

import type { Bindings } from '../shared/bindings.js'
import { cancelled } from '../shared/format.js'
import type { Requests, Revision, Summary, ViewState } from '../shared/messages.js'
import { isReference, nameFieldOf, networkOf, positionOf } from '../shared/schema.js'

/** The static fields a view draws: their names, places, routes and references, and those its
 *  mappings read; of the types the Network draws when `network`, else of every type. */
export function staticNeeds(
  summary: Summary,
  bindings: Bindings | undefined,
  network: boolean,
): FieldSelection[] {
  const { schema } = summary
  const bound = Object.values(bindings ?? {})
  const drawn = networkOf(schema)
  const types = network
    ? new Set([...drawn.vertices, ...drawn.edges.map((edge) => edge.type)])
    : undefined
  return staticFields(schema)
    .filter((field) => !types || types.has(field.from))
    .map((field) => ({
      ...field,
      select: field.select.filter(
        (name) =>
          bound.some((binding) => binding.type === field.from && binding.field === name) ||
          name === nameFieldOf(schema, field.from) ||
          [positionOf(schema, field.from)?.x, positionOf(schema, field.from)?.y].includes(name) ||
          drawn.edges.some((edge) => edge.type === field.from && edge.bends === name) ||
          isReference(schema.types[field.from]!.fields[name]),
      ),
    }))
    .filter((field) => field.select.length > 0)
}

/** What a view's rows are of: a case's revision, or, with `results`, the case they were read
 *  against, which `summary` then describes. */
export interface Of {
  readonly summary: Summary
  readonly results?: string
}

/** The rows held, as data, and what they are of. */
export interface Snapshot {
  readonly data: Data
  readonly revision: Revision
  /** The static fields held, each as `type.field`. */
  readonly fields: ReadonlySet<string>
  /** Where the diagram's blocks are arranged, when it was asked for. */
  readonly presentation?: Record<string, Positions>
}

export interface RowsOptions {
  readonly request: (
    input: Requests['rows']['input'],
    signal: AbortSignal,
  ) => Promise<readonly RowBatch[]>
  readonly presentation: (
    input: Requests['presentation']['input'],
    signal: AbortSignal,
  ) => Promise<Record<string, Positions>>
  /** Hears each change in the rows held. */
  readonly changed: () => void
  readonly report: (reason: unknown) => void
}

const nameOf = (type: string, field: string) => type + '.' + field
const revisionOf = ({ uri, version, attachmentId }: Summary): Revision => ({
  uri,
  version,
  ...(attachmentId !== undefined && { attachmentId }),
})

/** Each schema by its text: a revision carries a copy, and the renderers keep their cached work only
 *  for the same schema object. */
let known: { readonly value: Schema; readonly text: string } | undefined
function schemaOf(schema: Schema): Schema {
  const text = JSON.stringify(schema)
  if (known?.text !== text) known = { value: schema, text }
  return known.value
}

/** `batches` with each type's ids held once: rows asked for again bring their ids again. */
function joined(held: readonly RowBatch[], batches: readonly RowBatch[]): RowBatch[] {
  const named = new Set(held.filter((batch) => batch.ids).map((batch) => batch.index.type))
  return [
    ...held,
    ...batches.map((batch) => {
      if (!batch.ids || !named.has(batch.index.type)) return batch
      const { ids: _, ...rest } = batch
      return rest
    }),
  ]
}

/** The rows of `of` that `fields` select, asked for once. */
export async function rowsOnce(
  options: Pick<RowsOptions, 'request' | 'presentation'>,
  { summary, results }: Of,
  fields: readonly FieldSelection[],
  presentation: boolean,
  signal: AbortSignal,
): Promise<Snapshot> {
  const revision = revisionOf(summary)
  const [batches, positions] = await Promise.all([
    options.request({ ...revision, fields, ...(results && { results }) }, signal),
    presentation
      ? options.presentation({ ...revision, ...(results && { results }) }, signal)
      : undefined,
  ])
  return {
    data: createData(schemaOf(summary.schema), joined([], batches)),
    revision,
    fields: new Set(fields.flatMap(({ from, select }) => select.map((name) => nameOf(from, name)))),
    ...(positions && { presentation: positions }),
  }
}

/** The rows one view holds: of the latest revision it was asked for, those fields it was. */
export class Rows {
  #snapshot?: Snapshot
  /** What the held batches are of, and the batches. */
  #key = ''
  #batches: RowBatch[] = []
  #held = new Set<string>()
  #positions?: Record<string, Positions>
  #wanted?: { of: Of; fields: readonly FieldSelection[]; presentation: boolean }
  #flight?: AbortController
  /** Asks that failed, not asked again until something changes. */
  readonly #spent = new Set<string>()

  constructor(private readonly options: RowsOptions) {}

  /** The rows held, which may be of a revision before the latest asked for until its rows come. */
  get snapshot(): Snapshot | undefined {
    return this.#snapshot
  }

  /** Ask for the rows of `of` that `fields` select and the view lacks, and, with `presentation`,
   *  where the diagram's blocks are arranged. */
  want(of: Of | undefined, fields: readonly FieldSelection[], presentation = false): void {
    if (!of) return
    this.#wanted = { of, fields, presentation }
    const { summary } = of
    const key = [summary.uri, summary.version, summary.attachmentId, summary.fingerprint].join('\n')
    if (key !== this.#key) {
      // Another revision starts over; the last rows stay on show until its own come.
      this.#flight?.abort()
      this.#flight = undefined
      this.#key = key
      this.#batches = []
      this.#held = new Set()
      this.#positions = undefined
    }
    if (this.#flight) return
    const lacking = fields
      .map(({ from, select }) => ({
        from,
        select: select.filter((name) => !this.#held.has(nameOf(from, name))),
      }))
      .filter(({ select }) => select.length > 0)
    const placed = !presentation || this.#positions !== undefined
    const ask = key + '\n' + JSON.stringify(lacking) + placed
    if ((!lacking.length && placed && this.#snapshot && this.#current()) || this.#spent.has(ask))
      return
    void this.#ask(key, of, lacking, !placed, ask)
  }

  /** Ask again for what failed, as when the user reloads a view. */
  retry(): void {
    this.#spent.clear()
    if (this.#wanted) this.want(this.#wanted.of, this.#wanted.fields, this.#wanted.presentation)
  }

  /** Whether the rows held are of the revision last asked for. */
  #current(): boolean {
    const summary = this.#wanted?.of.summary
    const revision = this.#snapshot?.revision
    return !!summary && revision?.uri === summary.uri && revision.version === summary.version
  }

  async #ask(
    key: string,
    { summary, results }: Of,
    lacking: readonly FieldSelection[],
    placing: boolean,
    ask: string,
  ) {
    const controller = (this.#flight = new AbortController())
    const revision = revisionOf(summary)
    try {
      const [batches, positions] = await Promise.all([
        lacking.length || !this.#batches.length
          ? this.options.request(
              { ...revision, fields: lacking, ...(results && { results }) },
              controller.signal,
            )
          : [],
        placing
          ? this.options.presentation(
              { ...revision, ...(results && { results }) },
              controller.signal,
            )
          : this.#positions,
      ])
      if (controller.signal.aborted || key !== this.#key) return
      this.#batches = joined(this.#batches, batches)
      for (const { from, select } of lacking)
        for (const name of select) this.#held.add(nameOf(from, name))
      this.#positions = positions
      this.#snapshot = {
        data: createData(schemaOf(summary.schema), this.#batches),
        revision,
        fields: new Set(this.#held),
        ...(positions && { presentation: positions }),
      }
      this.options.changed()
    } catch (error) {
      if (controller.signal.aborted) return
      this.#spent.add(ask)
      // A revision read again since it was asked for is no failure: the newer one is asked for.
      if (!cancelled(error) && (error as { code?: string })?.code !== 'stale')
        this.options.report(error)
    } finally {
      if (this.#flight === controller) this.#flight = undefined
      // What the view came to want meanwhile.
      if (this.#wanted && !controller.signal.aborted)
        this.want(this.#wanted.of, this.#wanted.fields, this.#wanted.presentation)
    }
  }
}

/** Whether `snapshot` holds the rows of the revision `state` shows. */
export function current(snapshot: Snapshot | undefined, state: ViewState): boolean {
  const summary = state.summary
  const revision = snapshot?.revision
  return (
    !!revision &&
    !!summary &&
    revision.uri === summary.uri &&
    revision.version === summary.version &&
    revision.attachmentId === summary.attachmentId
  )
}

/** Whether the Network can draw `snapshot`: rows of this revision, holding the static fields its
 *  mappings read. A sampled field comes from the results, which the view checks against the time
 *  it draws. State may come before its rows, and the last frame stays until both agree. */
export function drawable(snapshot: Snapshot | undefined, state: ViewState): boolean {
  if (!current(snapshot, state) || state.stale) return false
  const summary = state.summary!
  return Object.values(state.bindings ?? {}).every(({ type, field }) => {
    const definition = summary.schema.types[type]?.fields[field]
    if (!definition || definition.sampled) return true
    return snapshot!.fields.has(nameOf(type, field))
  })
}

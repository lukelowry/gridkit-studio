import { Data, field, type View } from 'latkit'

import { type BlockDefinition, type Entity, entityKey } from '../../shared/document.js'
import { type Mutation, revisionOf, type Summary } from '../../shared/messages.js'
import { bridge } from '../bridge.js'

export interface Move {
  readonly entity: Entity
  readonly position: readonly [number, number]
}

export function previewOf(source: Data): Data {
  using snapshot = source.snapshot()
  return new Data(source.name).restore(snapshot)
}

export function positions(data: Data, blocks: readonly BlockDefinition[]): Move[] {
  const moves: Move[] = []
  for (const block of blocks) {
    const result = data.query({
      of: block.table,
      select: { x: field(block.position[0]), y: field(block.position[1]) },
    })
    const { x, y } = result.fields
    if (!(x instanceof Float64Array) || !(y instanceof Float64Array))
      throw new Error('Diagram positions must be numeric.')
    for (let index = 0; index < result.ids.length; index++) {
      if (Number.isFinite(x[index]) && Number.isFinite(y[index]))
        moves.push({
          entity: { table: block.table, id: result.ids[index]! },
          position: [x[index]!, y[index]!],
        })
    }
  }
  return moves
}

/** Preview ownership lasts for one source revision. Only source transactions commit edits. */
export class DiagramEditor {
  readonly #controller = new AbortController()
  readonly #stop: Array<() => void> = []
  #preview?: Data
  #busy = false
  #ready?: Promise<void>
  #closed = false
  readonly #original: Map<string, readonly [number, number]>

  constructor(
    readonly view: View,
    readonly source: Data,
    readonly summary: Summary,
    readonly replace: (data: Data) => void,
    readonly error: (error: unknown) => void,
  ) {
    this.#original = new Map(
      positions(source, summary.definition.drawing.blocks).map((move) => [
        entityKey(move.entity),
        move.position,
      ]),
    )
    this.#stop.push(
      view.on('drag', ({ phase, hit, position }) => {
        void (async () => {
          if (this.#ready) await this.#ready
          if (!this.#preview || this.#busy || this.#closed) return
          const block = summary.definition.drawing.blocks.find(
            (block) => block.table === hit.row.table,
          )
          if (!block) return
          this.#preview.set(block.table, [hit.row.id], {
            [block.position[0]]: [position[0]],
            [block.position[1]]: [position[1]],
          })
          if (phase === 'end') await this.#commit(this.#moves(), 'Move diagram blocks')
        })().catch(error)
      }),
      view.on('connect', ({ from, to }) => {
        if (!from.port) {
          error(new Error('Start a connection at a signal port.'))
          return
        }
        void this.#commit(
          [
            {
              kind: 'connect',
              from: { table: from.row.table, id: from.row.id, field: from.port },
              to: to
                ? { table: to.row.table, id: to.row.id, ...(to.port ? { field: to.port } : {}) }
                : null,
            },
          ],
          to ? 'Connect signal ports' : 'Disconnect signal port',
        ).catch(error)
      }),
      view.on('delete', ({ rows }) => {
        const entities = rows.flatMap((row) => row.ids.map((id) => ({ table: row.table, id })))
        if (entities.length)
          void this.#commit([{ kind: 'remove', entities }], 'Delete diagram elements').catch(error)
      }),
    )
    void this.#prepare().catch(error)
  }

  #prepare(all = false): Promise<void> {
    const task = (async () => {
      const signal = this.#controller.signal
      signal.throwIfAborted()
      this.#preview?.destroy()
      const preview = (this.#preview = previewOf(this.source))
      if (all)
        for (const block of this.summary.definition.drawing.blocks) {
          const ids = preview.query({ of: block.table, select: {} }).ids
          preview.set(block.table, ids, {
            [block.position[0]]: new Float64Array(ids.length).fill(NaN),
            [block.position[1]]: new Float64Array(ids.length).fill(NaN),
          })
        }
      this.replace(preview)
      for (const patch of await this.view.arrange({ signal })) {
        signal.throwIfAborted()
        if (patch.data === preview.name) preview.apply(patch)
      }
    })()
    this.#ready = task
    void task
      .finally(() => {
        if (this.#ready === task) this.#ready = undefined
      })
      .catch(() => {})
    return task
  }

  #moves(): Mutation[] {
    if (!this.#preview) return []
    return positions(this.#preview, this.summary.definition.drawing.blocks)
      .filter((move) => {
        const original = this.#original.get(entityKey(move.entity))
        return !original || original[0] !== move.position[0] || original[1] !== move.position[1]
      })
      .map((move) => ({ kind: 'move', ...move }))
  }

  async #commit(mutations: Mutation[], label: string): Promise<void> {
    if (this.#closed || this.#busy) return
    if (this.#ready) await this.#ready
    if (!mutations.length) return
    this.#busy = true
    let committed = false
    try {
      await bridge.request(
        'transact',
        { revision: revisionOf(this.summary), mutations, label },
        this.#controller.signal,
      )
      committed = true
    } finally {
      if (!this.#closed) {
        this.replace(this.source)
        this.#preview?.destroy()
        this.#preview = undefined
        // The next source revision re-enables editing. A rejected transaction can be retried.
        this.#busy = false
        if (!committed) void this.#prepare().catch(this.error)
      }
    }
  }

  async arrange(): Promise<void> {
    if (this.#closed || this.#busy) return
    if (this.#ready) await this.#ready
    await this.#prepare(true)
    await this.#commit(this.#moves(), 'Arrange diagram')
  }

  destroy(): void {
    this.#closed = true
    this.#controller.abort()
    for (const stop of this.#stop) stop()
    this.#preview?.destroy()
    this.#preview = undefined
  }
}

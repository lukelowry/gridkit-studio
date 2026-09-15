import { setImmediate } from 'node:timers/promises'

import type { ClassData, Column, GridSort } from '@latkit/model'

import { SharedCache } from '../cache.js'
import type { QuerySpec, Table, TableView } from './query.js'

export interface Recording {
  readonly ids: readonly string[]
  snapshot(spec: QuerySpec, signal?: AbortSignal): Promise<{ frame: number; time?: number }>
  read(
    frame: number,
    fields: readonly number[],
    elements: readonly number[],
    signal?: AbortSignal,
  ): Promise<Float64Array>
}
type Order = { total: number; indices?: Uint32Array; sorted?: boolean }
const BATCH = 2048
const text = (value: string | number | null) =>
  value === null || (typeof value === 'number' && Number.isNaN(value)) ? '' : String(value)
const cell = (column: Column, index: number) =>
  column.kind === 'flag' ? (column.values[index] ? 'true' : 'false') : text(column.values[index])
async function yieldToReader(signal?: AbortSignal) {
  await setImmediate()
  signal?.throwIfAborted()
}
/** Columnar data stays in the worker. Cached orders contain identities, never formatted rows. */
export class TableEngine implements Table {
  readonly rowCount: number
  private readonly orders = new SharedCache<Order>(
    64 * 1024 * 1024,
    (order) => order.indices?.byteLength ?? 0,
  )
  private readonly inverses = new SharedCache<Uint32Array>(
    16 * 1024 * 1024,
    (value) => value.byteLength,
    4,
  )
  private readonly orderIds = new WeakMap<Order, string>()
  private readonly lifetime = new AbortController()
  private serial = 0
  constructor(
    private readonly data: ClassData,
    private readonly recording?: Recording,
  ) {
    this.rowCount = data.labels.length
  }
  private staticText(index: number) {
    return [this.data.labels[index], ...this.data.columns.map((column) => cell(column, index))]
      .join(' ')
      .toLowerCase()
  }
  private staticHits(filter: string, signal: AbortSignal): Promise<Order> {
    if (!filter) return Promise.resolve({ total: this.rowCount })
    return this.orders.get(
      JSON.stringify(['filter', filter]),
      async (abort) => {
        const indices = new Uint32Array(this.rowCount)
        let total = 0
        const batch = Math.max(
          32,
          Math.min(BATCH, Math.floor(16384 / (this.data.columns.length + 1))),
        )
        for (let index = 0; index < this.rowCount; index++) {
          if (
            this.data.labels[index].toLowerCase().includes(filter) ||
            this.staticText(index).includes(filter)
          )
            indices[total++] = index
          if ((index + 1) % batch === 0) await yieldToReader(abort)
        }
        return total === this.rowCount ? { total } : { total, indices: indices.slice(0, total) }
      },
      signal,
    )
  }
  private async order(
    filter: string,
    sort: GridSort | null,
    frame: number | null,
    signal: AbortSignal,
  ): Promise<Order> {
    const dynamicSort = this.recording?.ids.indexOf(sort?.column ?? '') ?? -1
    const staticOrder = await this.staticHits(filter, signal)
    if (filter && staticOrder.total === this.rowCount) return this.order('', sort, frame, signal)
    const dynamic = !!this.recording && (!!filter || dynamicSort >= 0)
    const key = JSON.stringify(['order', filter, sort, dynamic ? frame : null])
    return this.orders.get(
      key,
      async (abort) => {
        let order = staticOrder
        if (filter && this.recording && frame! >= 0 && order.total < this.rowCount) {
          const indices = new Uint32Array(this.rowCount)
          let total = 0
          let match = 0
          const fields = this.recording.ids.map((_, i) => i)
          const batch = Math.max(1, Math.min(BATCH, Math.floor(131072 / fields.length)))
          for (let offset = 0; offset < this.rowCount; offset += batch) {
            const elements = Array.from(
              { length: Math.min(batch, this.rowCount - offset) },
              (_, i) => offset + i,
            )
            const missing: number[] = []
            const matches = new Uint8Array(elements.length)
            for (let i = 0; i < elements.length; i++) {
              if (order.indices?.[match] === elements[i]) {
                matches[i] = 1
                match++
              } else missing.push(elements[i])
            }
            const values = missing.length
              ? await this.recording.read(frame!, fields, missing, abort)
              : new Float64Array()
            let sample = 0
            for (let i = 0; i < elements.length; i++) {
              const index = elements[i]
              if (matches[i]) indices[total++] = index
              else {
                const recorded = Array.from(
                  values.subarray(sample * fields.length, ++sample * fields.length),
                  text,
                )
                  .join(' ')
                  .toLowerCase()
                if (
                  recorded.includes(filter) ||
                  (filter.includes(' ') &&
                    (this.staticText(index) + ' ' + recorded).includes(filter))
                )
                  indices[total++] = index
              }
            }
            await yieldToReader(abort)
          }
          order = total === this.rowCount ? { total } : { total, indices: indices.slice(0, total) }
        }
        if (!sort || !order.total) return order
        const column = this.data.columns.find((column) => column.id === sort.column)
        if (sort.column !== null && !column && dynamicSort < 0) return order
        let recorded: Float64Array | undefined
        if (dynamicSort >= 0) {
          recorded = new Float64Array(this.rowCount).fill(NaN)
          for (let offset = 0; offset < order.total; offset += BATCH) {
            const elements = Array.from(
              { length: Math.min(BATCH, order.total - offset) },
              (_, i) => order.indices?.[offset + i] ?? offset + i,
            )
            const values = await this.recording!.read(frame!, [dynamicSort], elements, abort)
            elements.forEach((index, i) => {
              recorded![index] = values[i]
            })
            await yieldToReader(abort)
          }
        }
        const direction = sort.dir === 'asc' ? 1 : -1
        const compare = (a: number, b: number) => {
          const x = recorded ? recorded[a] : column ? column.values[a] : this.data.labels[a]
          const y = recorded ? recorded[b] : column ? column.values[b] : this.data.labels[b]
          const missingX = x === null || (typeof x === 'number' && Number.isNaN(x))
          const missingY = y === null || (typeof y === 'number' && Number.isNaN(y))
          if (missingX || missingY) return Number(missingX) - Number(missingY) || a - b
          const compared =
            typeof x === 'string' && typeof y === 'string'
              ? x.localeCompare(y)
              : x < y
                ? -1
                : x > y
                  ? 1
                  : 0
          return direction * compared || a - b
        }
        let indices = order.indices?.slice() ?? new Uint32Array(order.total)
        if (!order.indices)
          for (let i = 0; i < indices.length; i++) {
            indices[i] = i
            if ((i + 1) % (BATCH * 4) === 0) await yieldToReader(abort)
          }
        for (let offset = 0; offset < indices.length; offset += BATCH) {
          indices.subarray(offset, offset + BATCH).sort(compare)
          await yieldToReader(abort)
        }
        let scratch = new Uint32Array(indices.length)
        for (let size = BATCH; size < indices.length; size *= 2) {
          for (let start = 0; start < indices.length; start += 2 * size) {
            const middle = Math.min(start + size, indices.length)
            const end = Math.min(start + 2 * size, indices.length)
            let left = start
            let right = middle
            for (let at = start; at < end; at++) {
              scratch[at] =
                right >= end || (left < middle && compare(indices[left], indices[right]) <= 0)
                  ? indices[left++]
                  : indices[right++]
              if ((at + 1) % (BATCH * 4) === 0) await yieldToReader(abort)
            }
          }
          ;[indices, scratch] = [scratch, indices]
        }
        return { total: indices.length, indices, sorted: true }
      },
      signal,
    )
  }
  async query(spec: QuerySpec, signal?: AbortSignal): Promise<TableView> {
    const abort = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    abort.throwIfAborted()
    const snapshot = this.recording ? await this.recording.snapshot(spec, abort) : { frame: null }
    const order = await this.order(
      spec.filter.trim().toLowerCase(),
      spec.sort,
      snapshot.frame,
      abort,
    )
    abort.throwIfAborted()
    const life = new AbortController()
    const check = (signal?: AbortSignal) => {
      this.lifetime.signal.throwIfAborted()
      life.signal.throwIfAborted()
      signal?.throwIfAborted()
      return AbortSignal.any([this.lifetime.signal, life.signal, ...(signal ? [signal] : [])])
    }
    return {
      id: String(++this.serial),
      total: order.total,
      ...snapshot,
      read: async (offset, count, columns, signal) => {
        const abort = check(signal)
        if (
          ![offset, count].every((n) => Number.isSafeInteger(n) && n >= 0) ||
          count > 4096 ||
          columns.length > 512 ||
          columns.some(
            (i) =>
              !Number.isInteger(i) ||
              i < -1 ||
              i >= this.data.columns.length + (this.recording?.ids.length ?? 0),
          )
        )
          throw new RangeError('Invalid table window.')
        const elements = Array.from(
          { length: Math.max(0, Math.min(count, order.total - offset)) },
          (_, i) => order.indices?.[offset + i] ?? offset + i,
        )
        const picked = columns
          .filter((i) => i >= this.data.columns.length)
          .map((i) => i - this.data.columns.length)
        const values = picked.length
          ? await this.recording!.read(snapshot.frame!, picked, elements, abort)
          : undefined
        abort.throwIfAborted()
        return {
          total: order.total,
          rows: elements.map((index, row) => {
            let field = 0
            return {
              index,
              label: this.data.labels[index],
              cells: columns.map((i) =>
                i < 0
                  ? this.data.labels[index]
                  : i < this.data.columns.length
                    ? cell(this.data.columns[i], index)
                    : text(values![row * picked.length + field++]),
              ),
            }
          }),
        }
      },
      locate: async (element, signal) => {
        const abort = check(signal)
        if (!Number.isSafeInteger(element) || element < 0 || element >= this.rowCount) return null
        if (!order.indices) return element
        if (!order.sorted) {
          let low = 0
          let high = order.total
          while (low < high) {
            const mid = low + Math.floor((high - low) / 2)
            if (order.indices[mid] < element) low = mid + 1
            else high = mid
          }
          return order.indices[low] === element ? low : null
        }
        if (order.total >= this.rowCount / 4 && this.rowCount * 4 <= 16 * 1024 * 1024) {
          let key = this.orderIds.get(order)
          if (!key) {
            key = String(++this.serial)
            this.orderIds.set(order, key)
          }
          const inverse = await this.inverses.get(
            key,
            async (signal) => {
              const positions = new Uint32Array(this.rowCount).fill(0xffffffff)
              for (let i = 0; i < order.total; i++) {
                positions[order.indices![i]] = i
                if ((i + 1) % (BATCH * 4) === 0) await yieldToReader(signal)
              }
              return positions
            },
            abort,
          )
          return inverse[element] === 0xffffffff ? null : inverse[element]
        }
        for (let offset = 0; offset < order.total; offset += BATCH * 8) {
          const at = order.indices.subarray(offset, offset + BATCH * 8).indexOf(element)
          if (at >= 0) return offset + at
          await yieldToReader(abort)
        }
        return null
      },
      close: () => life.abort(),
    }
  }
  close() {
    this.lifetime.abort()
    this.orders.clear()
    this.inverses.clear()
  }
}

import {
  type Column,
  type Field,
  fieldKey,
  type FieldRef,
  fieldsOf,
  type Model,
  type Signal,
} from '@latkit/model'

import { type Binding, type DisplayChannel, renderValues } from './bindings.js'
import type { CsvSource } from './csv/source.js'

export class CaseFields {
  private readonly rendered = new Map<string, Float32Array>()
  time = 0
  frame: number | undefined
  constructor(
    readonly model: Model,
    private readonly currentCsvSource: () => CsvSource | undefined = () => undefined,
  ) {}
  get source(): CsvSource | undefined {
    return this.currentCsvSource()
  }
  setTime(time: number, frame?: number): void {
    this.time = time
    this.frame = frame
  }
  signals(classId: string): (Field & Signal)[] {
    const cls = this.model.classes.find((cls) => cls.id === classId)
    if (!cls) return []
    const signals = new Map(cls.signals.map((signal) => [signal.id, signal]))
    for (const field of this.source?.fields ?? [])
      if (field.classId === classId && !signals.has(field.id))
        signals.set(field.id, { id: field.id, label: field.id, unit: '', recorded: true })
    return [...signals.values()].map((signal) => ({
      ...signal,
      classId,
      source: 'signal' as const,
    }))
  }
  recorded(classId: string): Field[] {
    return this.signals(classId).filter((field) => this.source?.has(field))
  }
  async list(classId: string, signal?: AbortSignal): Promise<readonly Field[]> {
    const spec = this.model.classes.find((cls) => cls.id === classId)
    if (!spec) return []
    const data = await this.model.load(classId, signal)
    return [
      ...fieldsOf(spec, data).filter((field) => field.source === 'column'),
      ...this.recorded(classId),
    ]
  }
  async field(ref: FieldRef, signal?: AbortSignal): Promise<Column | Signal> {
    const found =
      ref.source === 'column'
        ? (await this.model.load(ref.classId, signal)).columns.find(
            (column) => column.id === ref.id,
          )
        : this.signals(ref.classId).find((signal) => signal.id === ref.id)
    if (!found) throw new Error('The field no longer exists.')
    return found
  }
  async column(
    ref: FieldRef,
    signal?: AbortSignal,
    time = this.time,
    frameIndex = time === this.time ? this.frame : undefined,
  ): Promise<Extract<Column, { kind: 'number' }>> {
    if (ref.source === 'signal') {
      const field = await this.field(ref, signal)
      const source = this.source
      if (!source?.has(ref)) throw new Error('No samples are available for this signal.')
      const count = this.model.classes.find((cls) => cls.id === ref.classId)!.count
      const frame = frameIndex ?? (await source.locate(time, signal))
      const values = await source.cellsAt(
        frame,
        [ref],
        Array.from({ length: count }, (_, i) => i),
        signal,
      )
      return { kind: 'number', id: ref.id, label: field.label, values }
    }
    const data = await this.model.load(ref.classId, signal)
    const column = data.columns.find((column) => column.id === ref.id)
    if (column?.kind !== 'number') throw new Error('The numeric field no longer exists.')
    return column
  }
  async values(
    channel: DisplayChannel,
    binding: Binding,
    signal?: AbortSignal,
    time = this.time,
    frame = this.frame,
  ): Promise<Float32Array> {
    const key = `${channel}\0${fieldKey(binding.field)}\0${JSON.stringify(binding.range)}`
    const found = this.rendered.get(key)
    if (found) return found
    const column = await this.column(binding.field, signal, time, frame)
    signal?.throwIfAborted()
    const values = renderValues(column.values, channel, binding.range)
    if (binding.field.source === 'column') {
      const held = [...this.rendered.values()].reduce((n, value) => n + value.byteLength, 0)
      if (held + values.byteLength > 16 * 1024 * 1024) this.rendered.clear()
      this.rendered.set(key, values)
    }
    return values
  }
}

export interface SignalState {
  total: number
  monitored: number
  available: number
  expected: number
  runStatus?: 'running' | 'completed' | 'cancelled' | 'failed'
}
export function signalStatus(signal: SignalState): string {
  if (signal.available)
    return signal.available === signal.total
      ? 'Samples available.'
      : `Samples for ${signal.available} of ${signal.total} elements.`
  if (signal.runStatus === 'running' && signal.expected) return 'Waiting for samples...'
  if (signal.expected && signal.runStatus) {
    if (signal.runStatus === 'completed') return 'GridKit did not output this signal.'
    if (signal.runStatus === 'failed') return 'The run failed before samples were available.'
    if (signal.runStatus === 'cancelled') return 'The run stopped before samples were available.'
  }
  if (signal.monitored) return 'Enabled for the next run.'
  return 'Not monitored.'
}

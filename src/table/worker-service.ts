import { type Port, serve } from '@latkit/port'

import type { CsvFile } from '../csv/worker.js'
import { type Recording, TableEngine } from './engine.js'
import { openTableProtocol } from './protocol.js'
import { serveTable } from './transport.js'

export function serveTableWorker(port: Port, file?: CsvFile) {
  return serve(port, openTableProtocol, async ({ id, data, recorded }) => {
    const maps = recorded.map((field) => {
      const columns = new Map<number, number>()
      field.elements.forEach((element, i) => columns.set(element, field.columns[i]))
      return columns
    })
    const recording: Recording | undefined =
      file && recorded.length
        ? {
            ids: recorded.map((field) => field.id),
            async snapshot(spec, signal) {
              const found = spec.frame ?? (await file.locate(spec.time ?? 0, signal))
              const frame = Math.min(found, (spec.frameCount ?? Infinity) - 1)
              return {
                frame,
                time: frame < 0 ? spec.time : (await file.read(frame, 1, [], signal)).time[0],
              }
            },
            async read(frame, fields, elements, signal) {
              if (frame < 0) return new Float64Array(fields.length * elements.length).fill(NaN)
              const columns = elements.flatMap((element) =>
                fields.map((field) => maps[field].get(element) ?? -1),
              )
              return (await file.read(frame, 1, columns, signal)).values
            },
          }
        : undefined
    serveTable(port, id, new TableEngine(data, recording))
    return null
  })
}

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { Case } from '../gridkit/case.js'
import { alive } from '../gridkit/runtime.js'
import type { SimulationInfo, SimulationRequest } from '../shared/messages.js'

interface Manifest {
  format: 1
  owner: { pid: number; instance: string }
  info: SimulationInfo
  request: SimulationRequest
  snapshot: string
  retained?: boolean
}

/** Completed recordings belong to workspace storage, never the worker's temporary folder. */
export class ResultStorage {
  readonly instance = randomUUID()
  readonly records = new Map<string, Manifest>()
  readonly #writes = new Map<string, Promise<void>>()
  constructor(readonly directory: string) {}
  path(id: string) {
    if (!/^[\da-f-]{36}$/i.test(id)) throw new Error('Invalid simulation identifier.')
    return join(this.directory, 'simulations', id)
  }
  async initialize() {
    const parent = join(this.directory, 'simulations')
    const entries = await readdir(parent).catch(() => [])
    for (const id of entries) {
      if (!/^[\da-f-]{36}$/i.test(id)) continue
      try {
        const record = JSON.parse(await readFile(join(this.path(id), 'manifest.json'), 'utf8')) as Manifest
        if (record.format !== 1 || record.info.id !== id) continue
        // A recording must stay inside the folder that owns it.
        const path = resolve(this.path(id), record.info.path)
        const child = relative(this.path(id), path)
        if (child.startsWith('..') || isAbsolute(child) || resolve(path) === resolve(this.path(id))) continue
        if (!/^[\da-f]{32}$/i.test(record.snapshot)) continue
        record.info.path = path
        if ((record.info.state === 'running' || record.info.state === 'preparing') &&
            (record.owner.pid === process.pid || !alive(record.owner.pid))) {
          record.info.state = 'interrupted'
          record.info.message = 'The extension stopped before this simulation completed.'
        }
        this.records.set(id, record)
      } catch { /* An incomplete manifest is not a successfully retained result. */ }
    }
  }
  async create(info: SimulationInfo, request: SimulationRequest, kase: Case) {
    const snapshot = kase.version
    const directory = join(this.directory, 'snapshots', snapshot)
    await mkdir(directory, { recursive: true })
    for (const [name, bytes] of [['case.json', kase.file], ['catalog.json', kase.catalog.text]] as const) {
      try { await writeFile(join(directory, name), bytes, { flag: 'wx' }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    await mkdir(this.path(info.id), { recursive: true })
    this.records.set(info.id, { format: 1, owner: { pid: process.pid, instance: this.instance }, info, request, snapshot })
    await this.save(info.id)
  }
  save(id: string): Promise<void> {
    const previous = this.#writes.get(id) ?? Promise.resolve()
    const write = previous.catch(() => {}).then(async () => {
      const record = this.records.get(id)
      if (!record) return
      const file = join(this.path(id), 'manifest.json')
      const temporary = file + '.' + randomUUID() + '.tmp'
      const saved = { ...record, info: { ...record.info, path: relative(this.path(id), record.info.path) } }
      await writeFile(temporary, JSON.stringify(saved))
      await rename(temporary, file)
    })
    this.#writes.set(id, write)
    void write.finally(() => { if (this.#writes.get(id) === write) this.#writes.delete(id) }).catch(() => {})
    return write
  }
  async source(id: string) {
    const record = this.records.get(id)
    if (!record) throw new Error('Unknown simulation.')
    return readFile(join(this.directory, 'snapshots', record.snapshot, 'case.json'), 'utf8')
  }
  async catalog(id: string) {
    const record = this.records.get(id)
    if (!record) throw new Error('Unknown simulation.')
    return JSON.parse(await readFile(join(this.directory, 'snapshots', record.snapshot, 'catalog.json'), 'utf8')) as unknown
  }
  async available(id: string) {
    const record = this.records.get(id)
    return !!record && !record.info.evicted && await stat(record.info.path).then(() => true, () => false)
  }
  async flush() { await Promise.all([...this.#writes.values()]) }
  async removeRecording(id: string) {
    const record = this.records.get(id)
    if (!record) return
    record.info.evicted = true
    await this.save(id)
    const files = await readdir(this.path(id), { withFileTypes: true })
    for (const file of files) if (file.isFile() && file.name !== 'manifest.json') await rm(join(this.path(id), file.name), { force: true })
  }
  async evict(budget: number, protectedIds: ReadonlySet<string>, beforeDelete: (id: string) => Promise<boolean>) {
    if (!Number.isFinite(budget) || budget < 64 * (1 << 20)) throw new Error('Result storage must be at least 64 MiB.')
    const sizes = await Promise.all([...this.records].map(async ([id, record]) => {
      const files = await readdir(this.path(id), { withFileTypes: true }).catch(() => [])
      let bytes = 0
      for (const file of files) if (file.isFile()) bytes += await stat(join(this.path(id), file.name)).then(s => s.size, () => 0)
      return { id, record, files, bytes }
    }))
    let bytes = sizes.reduce((sum, item) => sum + item.bytes, 0)
    for (const item of sizes.sort((a, b) => a.record.info.started - b.record.info.started)) {
      if (bytes <= budget) break
      if (protectedIds.has(item.id) || item.record.retained || ['running', 'preparing'].includes(item.record.info.state)) continue
      if (item.record.owner.instance !== this.instance && item.record.owner.pid !== process.pid && alive(item.record.owner.pid)) continue
      if (!(await beforeDelete(item.id))) continue
      await this.removeRecording(item.id)
      bytes -= item.bytes
    }
  }
}

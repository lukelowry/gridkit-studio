import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { Case } from '../gridkit/case.js'
import { alive } from '../gridkit/runtime.js'
import type { SimulationInfo, SimulationRequest } from '../shared/messages.js'

interface Manifest {
  format: 1
  owner: { pid: number; instance: string }
  info: SimulationInfo
  request: SimulationRequest
  cleanupPending?: boolean
}

/** Completed recordings belong to workspace storage, never the worker's temporary folder. */
export class ResultStorage {
  readonly instance = randomUUID()
  readonly records = new Map<string, Manifest>()
  readonly #writes = new Map<string, Promise<void>>()
  readonly #sizes = new Map<string, number>()
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
        const record = JSON.parse(
          await readFile(join(this.path(id), 'manifest.json'), 'utf8'),
        ) as Manifest
        if (record.format !== 1 || record.info.id !== id) continue
        // A recording must stay inside the folder that owns it.
        const path = resolve(this.path(id), record.info.path)
        const child = relative(this.path(id), path)
        if (child.startsWith('..') || isAbsolute(child) || resolve(path) === resolve(this.path(id)))
          continue
        record.info.path = path
        // Older evicted manifests may still own files after a failed deletion.
        if (record.info.evicted) record.cleanupPending = true
        let interrupted = false
        if (
          (record.info.state === 'running' || record.info.state === 'preparing') &&
          (record.owner.pid === process.pid || !alive(record.owner.pid))
        ) {
          record.info.state = 'interrupted'
          record.info.message = 'The extension stopped before this simulation completed.'
          interrupted = true
        }
        this.records.set(id, record)
        if (interrupted) await this.save(id)
      } catch {
        /* An incomplete manifest is not a successfully retained result. */
      }
    }
    for (const [id, record] of this.records)
      if (record.cleanupPending && this.#owned(record))
        await this.removeRecording(id).catch(() => {})
  }
  async create(info: SimulationInfo, request: SimulationRequest, kase: Case) {
    const directory = this.path(info.id)
    await mkdir(join(this.directory, 'simulations'), { recursive: true })
    // Exclusive creation makes rollback safe: this call owns every file in the directory.
    await mkdir(directory)
    try {
      // Keep the original source separate from the solver's staged case.json. All large files
      // share the recording's lifetime, so retention includes snapshots without orphan storage.
      for (const [name, bytes] of [
        ['source.case.json', kase.file],
        ['catalog.json', kase.catalog.text],
      ] as const) {
        const path = join(directory, name)
        const temporary = path + '.' + randomUUID() + '.tmp'
        try {
          await writeFile(temporary, bytes, { flag: 'wx' })
          await rename(temporary, path)
        } finally {
          await rm(temporary, { force: true })
        }
      }
      this.records.set(info.id, {
        format: 1,
        owner: { pid: process.pid, instance: this.instance },
        info,
        request,
      })
      await this.save(info.id)
    } catch (error) {
      this.records.delete(info.id)
      this.#sizes.delete(info.id)
      try {
        await rm(directory, { recursive: true, force: true })
      } catch {
        info.state = 'failed'
        info.message = 'Recording creation failed; cleanup will be retried.'
        info.evicted = true
        this.records.set(info.id, {
          format: 1,
          owner: { pid: process.pid, instance: this.instance },
          info,
          request,
          cleanupPending: true,
        })
        await this.save(info.id).catch(() => {})
      }
      throw error
    }
  }
  #enqueue(id: string, action: () => Promise<void>): Promise<void> {
    const previous = this.#writes.get(id) ?? Promise.resolve()
    const write = previous.catch(() => {}).then(action)
    this.#writes.set(id, write)
    void write
      .finally(() => {
        if (this.#writes.get(id) === write) this.#writes.delete(id)
      })
      .catch(() => {})
    return write
  }
  async #write(id: string) {
    this.#sizes.delete(id)
    const record = this.records.get(id)
    if (!record) return
    const file = join(this.path(id), 'manifest.json')
    const temporary = file + '.' + randomUUID() + '.tmp'
    const saved = {
      ...record,
      info: { ...record.info, path: relative(this.path(id), record.info.path) },
    }
    try {
      await writeFile(temporary, JSON.stringify(saved))
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  save(id: string): Promise<void> {
    return this.#enqueue(id, () => this.#write(id))
  }
  async source(id: string) {
    const record = this.records.get(id)
    if (!record) throw new Error('Unknown simulation.')
    return readFile(join(this.path(id), 'source.case.json'), 'utf8')
  }
  async catalog(id: string) {
    const record = this.records.get(id)
    if (!record) throw new Error('Unknown simulation.')
    return JSON.parse(await readFile(join(this.path(id), 'catalog.json'), 'utf8')) as unknown
  }
  async available(id: string) {
    const record = this.records.get(id)
    return (
      !!record &&
      !record.info.evicted &&
      (await stat(record.info.path).then(
        () => true,
        () => false,
      ))
    )
  }
  async flush() {
    await Promise.all([...this.#writes.values()])
  }
  async removeRecording(id: string) {
    return this.#enqueue(id, async () => {
      const record = this.records.get(id)
      if (!record) return
      record.info.evicted = true
      record.cleanupPending = true
      await this.#write(id)
      const files = await readdir(this.path(id), { withFileTypes: true })
      for (const file of files)
        if (file.isFile() && file.name !== 'manifest.json')
          await rm(join(this.path(id), file.name), { force: true })
      delete record.cleanupPending
      await this.#write(id)
    })
  }
  #owned(record: Manifest) {
    return (
      record.owner.instance === this.instance ||
      record.owner.pid === process.pid ||
      !alive(record.owner.pid)
    )
  }
  async #size(id: string, record: Manifest) {
    const active = ['running', 'preparing'].includes(record.info.state)
    const cached = this.#sizes.get(id)
    if (cached !== undefined && !active) return cached
    const files = await readdir(this.path(id), { withFileTypes: true })
    let bytes = 0
    for (const file of files)
      if (file.isFile())
        bytes += await stat(join(this.path(id), file.name)).then(
          (s) => s.size,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return 0
            throw error
          },
        )
    if (!active) this.#sizes.set(id, bytes)
    return bytes
  }
  async evict(
    budget: number,
    protectedIds: ReadonlySet<string>,
    beforeDelete: (id: string) => Promise<boolean>,
  ) {
    if (!Number.isFinite(budget) || budget < 0) throw new Error('Invalid result storage budget.')
    const failures: unknown[] = []
    // Cleanup already committed by a previous pass is independent of the current budget.
    for (const [id, record] of this.records) {
      if (!record.cleanupPending || protectedIds.has(id) || !this.#owned(record)) continue
      if (['running', 'preparing'].includes(record.info.state) || !(await beforeDelete(id)))
        continue
      await this.removeRecording(id).catch((error) => failures.push(error))
    }
    const entries = [...this.records]
    const sizes: { id: string; record: Manifest; bytes: number }[] = []
    // Bound filesystem concurrency; immutable recordings are measured only once between saves.
    let cursor = 0
    await Promise.all(
      Array.from({ length: Math.min(4, entries.length) }, async () => {
        while (cursor < entries.length) {
          const [id, record] = entries[cursor++]!
          sizes.push({ id, record, bytes: await this.#size(id, record) })
        }
      }),
    )
    let bytes = sizes.reduce((sum, item) => sum + item.bytes, 0)
    for (const item of sizes.sort((a, b) => a.record.info.started - b.record.info.started)) {
      if (bytes <= budget) break
      if (
        item.record.info.evicted ||
        protectedIds.has(item.id) ||
        item.record.info.retained ||
        ['running', 'preparing'].includes(item.record.info.state)
      )
        continue
      if (!this.#owned(item.record)) continue
      if (!(await beforeDelete(item.id))) continue
      if (item.record.info.retained) continue
      try {
        await this.removeRecording(item.id)
        bytes -= item.bytes - (await this.#size(item.id, item.record))
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Recording cleanup will be retried.')
  }
}

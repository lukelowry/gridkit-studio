/** The cases the worker reads from disk, and what they tell the extension of one. */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { Case } from '../gridkit/case.js'
import type { Catalog } from '../gridkit/definition.js'
import { rangeIn, type Span } from '../gridkit/offsets.js'
import { recordingOf } from '../gridkit/recording.js'
import { type Revision, revisionOf, type Summary } from '../shared/messages.js'

/** The name of the case at `uri` when its header gives none: its file's, as the Explorer shows it. */
export const nameOf = (uri: string) => decodeURIComponent(uri.split('/').at(-1) || 'Case')

/** The UTF-8 byte order mark, which VS Code leaves out of a file's text. */
const BOM = [0xef, 0xbb, 0xbf]

/** The case file at `uri`, read whole with `catalog` as GridKit reads it. Where it does not read,
 *  the error says where as VS Code counts: by line and character. */
export async function readCase(uri: string, catalog: Catalog, signal?: AbortSignal): Promise<Case> {
  const bytes = await readFile(fileURLToPath(uri), { signal })
  // Past a byte order mark, as VS Code shows the file, so places and fingerprints are its text's.
  const file = BOM.every((byte, at) => bytes[at] === byte) ? bytes.subarray(BOM.length) : bytes
  try {
    return await Case.parse(file, catalog, nameOf(uri), signal)
  } catch (error) {
    throw placed(file, error)
  }
}

/** `error`, which a read of `file` threw, with its places as VS Code counts. */
function placed(file: Uint8Array, error: unknown): unknown {
  const { offset, length, problems } = (error ?? {}) as Partial<Span> & {
    problems?: readonly (Span & { message: string })[]
  }
  if (typeof offset !== 'number') return error
  return Object.assign(error as Error, {
    range: rangeIn(file, { offset, length: length ?? 1 }),
    ...(problems && {
      problems: problems.map(({ message, ...span }) => ({ message, range: rangeIn(file, span) })),
    }),
  })
}

/** How many bytes of cases, and how many cases, the worker keeps of files let go of. */
const KEPT_BYTES = 128 << 20
const KEPT_CASES = 4

/** Cases of files the extension let go of, by URI, so a file opened again as it was reads nothing.
 *  Past KEPT_CASES or about KEPT_BYTES the least recently let go of go, and one larger than that
 *  is not kept. */
export class Recent<T extends { readonly kase: Case }> {
  readonly #entries = new Map<string, T>()
  #bytes = 0

  take(uri: string): T | undefined {
    const entry = this.#entries.get(uri)
    if (!entry) return undefined
    this.#entries.delete(uri)
    this.#bytes -= entry.kase.bytes
    return entry
  }

  keep(uri: string, entry: T): void {
    this.take(uri)
    const { bytes } = entry.kase
    if (bytes > KEPT_BYTES) return
    for (const [oldest, dropped] of this.#entries) {
      if (this.#bytes + bytes <= KEPT_BYTES && this.#entries.size < KEPT_CASES) break
      this.#entries.delete(oldest)
      this.#bytes -= dropped.kase.bytes
    }
    this.#entries.set(uri, entry)
    this.#bytes += bytes
  }
}

/** What the extension is told of `kase`, read at `revision`: what it counts, and what it records,
 *  read until `signal` lets go. Its issues are found apart, by validation. */
export async function summarize(
  kase: Case,
  revision: Revision,
  signal?: AbortSignal,
): Promise<Summary> {
  return {
    ...revisionOf(revision),
    name: kase.name,
    fingerprint: kase.version,
    definition: kase.definition,
    identities: Object.fromEntries(
      [...kase.tables].map(([type, { shape }]) => [type, shape.identity.name]),
    ),
    counts: Object.fromEntries(
      [...kase.tables].map(([type, table]) => [type, table.starts.at(-1)!]),
    ),
    recording: await recordingOf(kase, signal),
  }
}

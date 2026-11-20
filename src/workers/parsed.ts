/** Reads case files from disk and builds the summary the extension receives. */

import { Case } from '../gridkit/case.js'
import type { Catalog } from '../gridkit/definition.js'
import { rangeIn, type Span } from '../gridkit/offsets.js'
import { recordingOf } from '../gridkit/recording.js'
import { readFile } from '../platform/files.js'
import { fileURLToPath, nameOf } from '../platform/path.js'
import { type Revision, revisionOf, type Summary } from '../shared/messages.js'

/** The UTF-8 byte order mark, which VS Code leaves out of a file's text. */
const BOM = [0xef, 0xbb, 0xbf]

/** Strips the byte order mark, so offsets and fingerprints match the text VS Code shows. */
export async function caseBytes(uri: string, signal?: AbortSignal): Promise<Uint8Array> {
  const bytes = await readFile(fileURLToPath(uri), { signal })
  return BOM.every((byte, at) => bytes[at] === byte) ? bytes.subarray(BOM.length) : bytes
}

/** A parse error carries VS Code line and character ranges. */
export async function parseCase(
  file: Uint8Array,
  uri: string,
  catalog: Catalog,
  version: string | undefined,
  signal?: AbortSignal,
): Promise<Case> {
  try {
    return await Case.parse(file, catalog, { name: nameOf(uri) || undefined, signal, version })
  } catch (error) {
    throw withRanges(file, error)
  }
}

function withRanges(file: Uint8Array, error: unknown): unknown {
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

/** Issues come separately, from validation. */
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

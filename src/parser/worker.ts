import { parentPort } from 'node:worker_threads'

import { serve } from '@latkit/port'

import { workerPort } from '../csv/port.js'
import { prepareCase } from '../gridkit/parse.js'
import { indexElements, locate, type Span, syntaxIssues } from '../gridkit/source.js'
import { CaseError } from '../gridkit/validate.js'
import { type ParseReply, parserProtocol } from './protocol.js'
const snapshots = new Map<
  string,
  { prepared: ReturnType<typeof prepareCase>; text: string; sources?: ReadonlyMap<string, Span> }
>()
if (parentPort)
  serve(workerPort(parentPort), parserProtocol, async (query, signal) => {
    signal.throwIfAborted()
    if (query.type === 'release') {
      snapshots.delete(query.id)
      return null
    }
    if (query.type === 'parse') {
      try {
        const prepared = prepareCase(new TextEncoder().encode(query.text))
        snapshots.set(query.id, { prepared, text: query.text })
        const { loader: _, ...value } = prepared
        return { state: 'valid', value } satisfies ParseReply
      } catch (error) {
        const issues =
          error instanceof CaseError
            ? [{ ...locate(query.text, error.path), message: error.message }]
            : error instanceof SyntaxError
              ? syntaxIssues(query.text)
              : []
        if (!issues.length)
          issues.push({
            offset: 0,
            length: 0,
            message: error instanceof Error ? error.message : String(error),
          })
        return { state: 'invalid', issues } satisfies ParseReply
      }
    }
    const snapshot = snapshots.get(query.id)
    if (!snapshot)
      throw new Error('The parsed case has been released. Reopen the case to reload it.')
    if (query.type === 'load') return snapshot.prepared.loader.load(query.classId, signal)
    if (query.type === 'bytes') return snapshot.prepared.loader.bytes(signal)
    snapshot.sources ??= indexElements(snapshot.text)
    return snapshot.sources.get(query.key) ?? null
  })

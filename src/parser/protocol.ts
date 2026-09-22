import type { ClassData } from '@latkit/model'
import { protocol } from '@latkit/port'

import type { prepareCase } from '../gridkit/parse.js'
import type { Issue, Span } from '../gridkit/source.js'
export type PreparedCase = Omit<ReturnType<typeof prepareCase>, 'loader'>
export type ParseReply =
  { state: 'valid'; value: PreparedCase } | { state: 'invalid'; issues: readonly Issue[] }
export type ParserQuery =
  | { type: 'parse'; id: string; text: string }
  | { type: 'load'; id: string; classId: string }
  | { type: 'bytes'; id: string }
  | { type: 'release'; id: string }
  | { type: 'source'; id: string; key: string }
export const parserProtocol = protocol<
  ParserQuery,
  ParseReply | ClassData | Uint8Array | Span | null
>('gridkit.parser')

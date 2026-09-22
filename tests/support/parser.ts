import { parse } from '../../src/gridkit/parse.js'
import { elementKey, indexElements, locate, syntaxIssues } from '../../src/gridkit/source.js'
import { CaseError } from '../../src/gridkit/validate.js'
import type { CaseParser, ParsedDocument } from '../../src/parser/client.js'
export const inlineParser: CaseParser = {
  async parse(text, signal): Promise<ParsedDocument> {
    signal.throwIfAborted()
    try {
      const parsed = parse(new TextEncoder().encode(text))
      const sources = indexElements(text)
      return {
        state: 'valid',
        case: parsed,
        source: async (ref) => sources.get(elementKey(ref)),
        dispose() {},
      }
    } catch (error) {
      const issues =
        error instanceof CaseError
          ? [{ ...locate(text, error.path), message: error.message }]
          : syntaxIssues(text)
      return { state: 'invalid', issues }
    }
  },
  dispose() {},
}

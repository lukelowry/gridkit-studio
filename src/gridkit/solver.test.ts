import { describe, expect, it } from 'vitest'

import { readSolverLine, solverLine } from './solver.js'

describe("GridKit's own lines", () => {
  it('reads the level and keeps what the line says', () => {
    for (const [printed, level] of [
      ['ERROR', 'error'],
      ['WARNING', 'warn'],
      ['INFO', 'info'],
      ['DEBUG', 'debug'],
    ] as const) {
      expect(readSolverLine(`[${printed}] some words`)).toEqual({ level, text: 'some words' })
      expect(readSolverLine(`[${printed}][a][b c] some words`)).toEqual({
        level,
        text: 'some words',
      })
    }
    expect(readSolverLine('  some words  ')).toEqual({ level: 'info', text: 'some words' })
  })

  it("logs a simulation's first error as the reason, and later ones as details", () => {
    const line = '[ERROR][x] some words'
    expect(solverLine(line, 'DynamicSimulation', false)).toEqual({
      level: 'error',
      message: 'some words',
      raw: line,
    })
    expect(solverLine(line, 'DynamicSimulation', true)).toMatchObject({ level: 'debug' })
    // A contingency's failure is not the study's.
    expect(solverLine(line, 'ContingencyAnalysis', false)).toMatchObject({ level: 'warn' })
    expect(solverLine('some words', undefined, false)).toEqual({
      level: 'info',
      message: 'some words',
    })
    expect(solverLine('[ERROR]  ', undefined, false)).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'

import { readSolverLine, solverLine } from './solver.js'

describe("GridKit's own lines", () => {
  it('says why the solver stopped, and when, in plain words', () => {
    expect(
      readSolverLine(
        '[ERROR][rank 0][/tmp/sundials/src/idas/idas.c:5778][IDAHandleFailure] At t = 1.00243413347301 and h = 8.46164505233021e-10, the corrector convergence failed repeatedly or with |h| = hmin.',
      ),
    ).toMatchObject({
      level: 'error',
      text: 'the solver could not converge, even at its smallest step',
      at: 1.00243413347301,
      step: 8.46164505233021e-10,
    })
    // As real GridKit printed it for a run held to one step.
    expect(
      readSolverLine(
        '[ERROR][rank 0][/tmp/sundials/src/idas/idas.c:2878][IDASolve] At t = 1e-05, mxstep steps taken before reaching tout.',
      ),
    ).toMatchObject({ level: 'error', text: 'the solver reached its step limit', at: 1e-5 })
    expect(
      readSolverLine('[ERROR] Function IDASolve failed with flag IDA_TOO_MUCH_WORK!'),
    ).toMatchObject({ level: 'error', text: 'the solver reached its step limit' })
  })

  it("logs a simulation's first error as the reason, and the errors after it as details", () => {
    const first =
      '[ERROR][rank 0][/tmp/sundials/src/idas/idas.c:5778][IDAHandleFailure] At t = 1.00243413347301 and h = 8.46164505233021e-10, the corrector convergence failed repeatedly or with |h| = hmin.'
    expect(solverLine(first, 'DynamicSimulation', false)).toEqual({
      level: 'error',
      message:
        'At t = 1.00243 s the solver could not converge, even at its smallest step (step size 8.462e-10 s).',
      raw: first,
    })
    expect(
      solverLine('[ERROR] DynamicSimulation failed: Method in Ida class failed!', undefined, true),
    ).toMatchObject({ level: 'debug' })
    // A contingency's failure is not the study's.
    expect(solverLine(first, 'ContingencyAnalysis', false)).toMatchObject({ level: 'warn' })
    expect(solverLine('   ', undefined, false)).toBeUndefined()
  })

  it('keeps what it does not know as said, and the line as printed', () => {
    const line = '[WARNING] Bus 7 voltage below 0.5 p.u.'
    expect(readSolverLine(line)).toEqual({
      level: 'warn',
      text: 'Bus 7 voltage below 0.5 p.u.',
      raw: line,
    })
    expect(
      readSolverLine('Running GridKit from ghcr.io/lukelowry/gridkit:latest with Docker.'),
    ).toMatchObject({
      level: 'info',
      text: 'Running GridKit from ghcr.io/lukelowry/gridkit:latest with Docker.',
    })
  })
})

import { describe, expect, it } from 'vitest'

import { outputOf, readSolver } from './study.js'

describe('a solver file as Studio reads it', () => {
  it('reads the case, end time, output file and its layout, and nothing else', () => {
    const solver = readSolver(
      'IEEE39.solver.json',
      JSON.stringify({
        system_model_file: 'IEEE39.case.json',
        output_file: 'IEEE39.csv',
        tmax: 10,
        future_option: { anything: true },
        events: [{ time: 1, type: 'whatever GridKit reads' }],
      }),
    )
    expect(solver).toEqual({
      model: 'IEEE39.case.json',
      tmax: 10,
      output: 'IEEE39.csv',
      layout: 'wide',
    })
    // GridKit reads the layout without regard to case.
    expect(
      readSolver(
        'a.solver.json',
        '{"system_model_file":"a.case.json","tmax":1,"output_layout":"LONG"}',
      ).layout,
    ).toBe('long')
  })

  it('says why a solver file cannot run, naming the line of a syntax error', () => {
    expect(() => readSolver('a.solver.json', '{\n  "tmax": 1,\n  oops\n}')).toThrow(
      'a.solver.json, line 3:',
    )
    expect(() => readSolver('a.solver.json', '{"tmax": 1}')).toThrow('system_model_file')
    expect(() => readSolver('a.solver.json', '{"system_model_file": "a.json", "tmax": 1}')).toThrow(
      'system_model_file',
    )
    expect(() =>
      readSolver('a.solver.json', '{"system_model_file": "a.case.json", "tmax": 0}'),
    ).toThrow('tmax must be a time after 0')
  })

  it("takes the case's monitor over a wide output_file, as GridKit does", () => {
    const solver = { model: 'a.case.json', tmax: 1, output: 'run.csv', layout: 'wide' } as const
    const monitor = { file: 'case.csv' }
    expect(outputOf('a.solver.json', solver, monitor)).toEqual(monitor)
    expect(outputOf('a.solver.json', solver, undefined)).toEqual({ file: 'run.csv' })
    // The case's monitor is wide, so a long output_file is the run's own; without one, GridKit
    // still writes the case's.
    const long = { ...solver, layout: 'long' } as const
    expect(outputOf('a.solver.json', long, monitor)).toEqual({ file: 'run.csv' })
    expect(outputOf('a.solver.json', { ...long, output: undefined }, monitor)).toEqual(monitor)
    expect(() =>
      outputOf('a.solver.json', { model: 'a.case.json', tmax: 1, layout: 'wide' }, undefined),
    ).toThrow('write nothing to show')
  })
})

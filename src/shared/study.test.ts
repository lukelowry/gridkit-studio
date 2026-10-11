import { describe, expect, it } from 'vitest'

import { contingencyFile, outputOf, readSolver } from './study.js'

describe('a solver file as Studio reads it', () => {
  it('reads the case, end time and output file, and nothing else', () => {
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
    expect(solver).toEqual({ model: 'IEEE39.case.json', tmax: 10, output: 'IEEE39.csv' })
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

  it("takes the case's monitor over output_file, as GridKit does", () => {
    const solver = { model: 'a.case.json', tmax: 1, output: 'study.csv' }
    expect(outputOf('a.solver.json', solver, { file: 'case.arrow', format: 'arrow' })).toEqual({
      file: 'case.arrow',
      format: 'arrow',
    })
    expect(outputOf('a.solver.json', solver, undefined)).toEqual({
      file: 'study.csv',
      format: 'csv',
    })
    expect(() => outputOf('a.solver.json', { model: 'a.case.json', tmax: 1 }, undefined)).toThrow(
      'write nothing to show',
    )
  })

  it("names a study's files as GridKit does", () => {
    expect(contingencyFile({ base: '/work/IEEE39', ext: '.csv' }, 12)).toBe('/work/IEEE39_12.csv')
  })
})

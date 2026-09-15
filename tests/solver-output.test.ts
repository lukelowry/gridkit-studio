import { expect, it } from 'vitest'

import { type SolverIssue, SolverOutput } from '../src/gridkit/output.js'
it('decodes split ANSI messages and associates multiline device context', () => {
  const issues: SolverIssue[] = []
  const output = new SolverOutput((issue) => issues.push(issue))
  const message =
    '[\u001b[31mERROR\u001b[0m] \n\tInvalid initial parameter value type: "R": 0\n\tSee the "BusFault" device with "id": "fault_7" in the "devices" list of your JSON file.\n\n'
  for (const character of message) output.write('stderr', character)
  output.finish()
  expect(issues).toHaveLength(1)
  expect(issues[0].device).toEqual({ className: 'BusFault', id: 'fault_7' })
  expect(issues[0].parameter).toBe('R')
  expect(output.failure).toContain('Invalid initial')
})
it('preserves the actual exception and distinguishes reference failures', () => {
  const output = new SolverOutput(() => {})
  output.write(
    'stderr',
    "terminate called after throwing an instance of 'std::bad_variant_access'\n  what(): std::get: wrong index for variant",
  )
  output.finish()
  expect(output.failure).toContain('wrong index for variant')
  const comparison = new SolverOutput(() => {})
  comparison.write('stdout', '--- FAIL: Test monitor file vs reference file\n')
  comparison.finish()
  expect(comparison.comparisonFailed).toBe(true)
})
it('warnings and unrelated output do not become execution failures', () => {
  const issues: SolverIssue[] = []
  const output = new SolverOutput((issue) => issues.push(issue))
  output.write('stderr', '[WARNING] Example warning\n\nComplete in 0.1 seconds\n')
  output.finish()
  expect(issues).toEqual([
    { severity: 'warning', message: 'Example warning', parameter: undefined },
  ])
  expect(output.failure).toBeUndefined()
})

it('keeps interleaved stdout apart from a partial stderr diagnostic', () => {
  const output = new SolverOutput(() => {})
  output.write('stderr', '[ERROR] Invalid parameter')
  output.write('stdout', 'Complete in 1 second\n')
  output.write('stderr', ' type\nThe parameter H must be real.\n\n[ERROR] Error\n')
  output.finish()
  expect(output.failure).toBe('Invalid parameter type\nThe parameter H must be real.')
})

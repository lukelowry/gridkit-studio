import { expect, it } from 'vitest'

import { validateInput } from './tool-validation.js'
import { toolDefinitions } from './tools.js'

const validate = (name: string, input: unknown) =>
  validateInput(toolDefinitions.find((tool) => tool.name === 'gridkit_' + name)!.inputSchema, input)

it('rejects stale proposal vocabulary, unknown input and invalid polling without invoking a tool', () => {
  expect(() =>
    validate('simulate', { uri: 'case', requestId: 'one', program: 'DynamicSimulation' }),
  ).toThrow(/caseUri/)
  expect(() =>
    validate('simulate', {
      caseUri: 'case',
      requestId: 'one',
      program: 'DynamicSimulation',
      access: 'edit',
    }),
  ).toThrow(/unknown property access/)
  expect(() => validate('get_analysis', { analysisId: 'one', waitMs: 30001 })).toThrow(/maximum/)
  expect(() =>
    validate('read_signal_samples', {
      simulationId: 'one',
      componentType: 'Bus',
      field: 'Vm',
      componentIds: ['Bus/1', 'Bus/1'],
      timeRange: [0, 1],
      representation: { kind: 'exact', maxSamples: 10 },
    }),
  ).toThrow(/duplicate/)
})

it('accepts mixed atomic changes and nullable disconnection, but rejects malformed branches', () => {
  const input = {
    caseUri: 'case',
    caseRevision: 'revision',
    requestId: 'one',
    changes: [
      { kind: 'add', componentType: 'Bus', key: 1, fields: { name: 'New bus' } },
      { kind: 'connect', from: { componentId: 'Branch/tie', field: 'ports.bus1' }, to: null },
      { kind: 'move', componentId: 'Bus/1', position: [2, 3] },
    ],
  }
  expect(() => validate('edit_case', input)).not.toThrow()
  expect(() =>
    validate('edit_case', { ...input, changes: [{ kind: 'set', componentId: 'Bus/1' }] }),
  ).toThrow(/expected shape/)
})

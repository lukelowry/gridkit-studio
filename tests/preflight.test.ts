import { expect, it } from 'vitest'

import { validateSimulationCase } from '../src/gridkit/preflight.js'
import { validate } from '../src/gridkit/validate.js'
import { canonicalCase } from './support/case.js'

it('counts native monitors once per element, with case-insensitive bus names', () => {
  const raw = validate(
    canonicalCase({
      buses: [{ mon: ['vm', 'Vm'] }],
      devices: [
        {
          class: 'BusFault',
          ports: { bus: 0 },
          params: { state0: false },
          mon: ['ir', 'ir', 'ii'],
        },
      ],
    }),
  )
  expect(validateSimulationCase(raw)).toBe(3)
})
it.each([
  [{ class: 'Unknown' }, 'class'],
  [{ class: 'Genrou', ports: { bus: 0 }, params: { typo: 1 } }, 'params.typo'],
  [{ class: 'Genrou', ports: { bus: 0 }, params: { H: true } }, 'params.H'],
  [{ class: 'BusFault', ports: { bus: 0 }, params: { state0: 0 } }, 'params.state0'],
  [{ class: 'Genrou', ports: { bus: 0, speed: 99 } }, 'ports.speed'],
  [{ class: 'Genrou', ports: { bus: 0, typo: 1 } }, 'ports.typo'],
  [{ class: 'Genrou', ports: { bus: 0 }, mon: ['SPEED'] }, 'mon[0]'],
  [{ class: 'Genrou', ports: {} }, 'ports.bus'],
])('keeps a case inspectable but rejects unsupported native data: %j', (device, location) => {
  const raw = validate(canonicalCase({ buses: [{}], devices: [device] }))
  expect(() => validateSimulationCase(raw)).toThrow(location)
})
it('accepts declared signal connections and all supported renewable flags', () => {
  const raw = validate(
    canonicalCase({
      buses: [{}],
      signals: [{ signal_id: 1, name: 'speed' }],
      devices: [
        { class: 'Genrou', ports: { bus: 0, speed: 1 } },
        { class: 'Reecb', ports: { bus: 0 }, params: { PfFlag: 1, VFlag: false, Pqflag: 0 } },
      ],
    }),
  )
  expect(() => validateSimulationCase(raw)).not.toThrow()
})

it.each(['Bus', 'BusInfinite'])('rejects %s in the device list', (className) => {
  const raw = validate(canonicalCase({ devices: [{ class: className }] }))
  expect(() => validateSimulationCase(raw)).toThrow('unsupported')
})

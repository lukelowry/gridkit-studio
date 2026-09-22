import { canonicalMonitor } from './classes.js'
import { GRIDKIT_REVISION, modelContract } from './contract.js'
import { type Case, CaseError } from './validate.js'

/** Checks for the supported native JSON reader; inspection still accepts other models. */
export function validateSimulationCase(raw: Case): number {
  const signals = new Set(raw.signals?.map((signal) => signal.signal_id))
  const buses = new Set(raw.buses.map((bus) => bus.number))
  let columns = 0
  for (const list of ['buses', 'devices'] as const) {
    raw[list].forEach((element, index) => {
      const path = [list, index]
      const model = modelContract(element.class)
      if (!model || (list === 'devices' && ['Bus', 'BusInfinite'].includes(element.class)))
        throw new CaseError(
          [...path, 'class'],
          'is unsupported by the GridKit contract ' + GRIDKIT_REVISION.slice(0, 12),
        )
      for (const [key, value] of Object.entries(element.params)) {
        if (!model.parameters.includes(key))
          throw new CaseError(
            [...path, 'params', key],
            'is not a supported parameter for ' + element.class,
          )
        if (model.realParameters.includes(key) && typeof value !== 'number')
          throw new CaseError([...path, 'params', key], 'must be a number')
        if (element.class === 'BusFault' && key === 'state0' && typeof value !== 'boolean')
          throw new CaseError([...path, 'params', key], 'must be a boolean')
      }
      if ('ports' in element) {
        for (const key of model.buses)
          if (!buses.has(element.ports[key] as number))
            throw new CaseError([...path, 'ports', key], 'must reference a declared bus')
        for (const [key, value] of Object.entries(element.ports)) {
          if (model.buses.includes(key)) continue
          if (!model.inputs.includes(key) && !model.outputs.includes(key))
            throw new CaseError(
              [...path, 'ports', key],
              'is not a supported port for ' + element.class,
            )
          if (!signals.has(value as number))
            throw new CaseError([...path, 'ports', key], 'must reference a declared signal')
        }
      }
      const monitored = new Set<string>()
      element.mon?.forEach((name, at) => {
        const nativeName = list === 'buses' ? canonicalMonitor(element.class, name) : name
        if (!model.monitors.includes(nativeName))
          throw new CaseError(
            [...path, 'mon', at],
            'is not a supported monitor for ' + element.class,
          )
        monitored.add(nativeName)
      })
      columns += monitored.size
    })
  }
  return columns
}

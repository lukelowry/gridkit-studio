import { CONTRACT } from './contract.js'

const LABELS: Readonly<Record<string, string>> = {
  Esdc1a: 'ESDC1A',
  GastPti: 'GAST-PTI',
  Genrou: 'GENROU',
  Gensal: 'GENSAL',
  Hygov: 'HYGOV',
  Ieeest: 'IEEEST',
  Ieeet1: 'IEEET1',
  Reecb: 'REECB',
  Regca: 'REGCA',
  Repca: 'REPCA',
  SexsPti: 'SEXS-PTI',
  Tgov1: 'TGOV1',
}
export const CLASSES: Readonly<
  Record<string, { readonly label?: string; readonly monitors: readonly string[] }>
> = {
  ...Object.fromEntries(
    Object.entries(CONTRACT).map(([name, model]) => [
      name,
      { label: LABELS[name], monitors: model.monitors },
    ]),
  ),
  Signal: { monitors: [] },
}

export function identityColumn(classId: string): string {
  return classId === 'bus' ? 'top.number' : classId === 'signal' ? 'top.signal_id' : 'top.id'
}

export function classLabel(className: string): string {
  return CLASSES[className]?.label ?? className
}

export function classMonitors(className: string): readonly string[] {
  return CLASSES[className === 'BusInfinite' ? 'Bus' : className]?.monitors ?? []
}

// Display matches ignore case; retain the catalog spelling for case edits.
export function canonicalMonitor(className: string, raw: string): string {
  const lower = raw.toLowerCase()
  return classMonitors(className).find((known) => known.toLowerCase() === lower) ?? raw
}

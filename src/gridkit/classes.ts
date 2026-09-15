// Monitor names follow GridKit PhasorDynamics MonitorableVariables enums.
interface ClassInfo {
  readonly label?: string
  readonly monitors: readonly string[]
}

export const CLASSES: Readonly<Record<string, ClassInfo>> = {
  Branch: { monitors: ['ir1', 'ii1', 'im1', 'p1', 'q1', 'ir2', 'ii2', 'im2', 'p2', 'q2'] },
  Bus: { monitors: ['Vr', 'Vi', 'Vm', 'Va'] },
  BusFault: { monitors: ['state', 'ir', 'ii'] },
  BusToSignalAdapter: { monitors: [] },
  ConstantSignalSource: { monitors: [] },
  Esdc1a: { label: 'ESDC1A', monitors: ['efd', 'vc', 'vr', 'vf', 'se', 'vfe'] },
  GastPti: { label: 'GAST-PTI', monitors: ['pmech', 'xvalve', 'xflow', 'xtemp', 'vload', 'vtemp'] },
  GenClassical: { monitors: ['ir', 'ii', 'p', 'q', 'delta', 'omega', 'speed'] },
  Genrou: { label: 'GENROU', monitors: ['ir', 'ii', 'p', 'q', 'delta', 'omega', 'speed'] },
  Gensal: {
    label: 'GENSAL',
    monitors: [
      'ir',
      'ii',
      'p',
      'q',
      'delta',
      'omega',
      'speed',
      'Eqp',
      'psidp',
      'psiqpp',
      'psidpp',
      'vd',
      'vq',
      'te',
      'id',
      'iq',
    ],
  },
  Hygov: { label: 'HYGOV', monitors: ['pmech', 'filter', 'desiredgate', 'gate', 'flow', 'head'] },
  Ieeest: { label: 'IEEEST', monitors: ['vss'] },
  Ieeet1: { label: 'IEEET1', monitors: ['efd', 'ksat'] },
  LoadZ: { monitors: ['p', 'q'] },
  LoadZIP: { monitors: ['ir', 'ii', 'im', 'p', 'q'] },
  Reecb: { label: 'REECB', monitors: ['iqcmd', 'ipcmd', 'vmeas', 'pmeas'] },
  Regca: { label: 'REGCA', monitors: ['ir', 'ii', 'p', 'q'] },
  Repca: { label: 'REPCA', monitors: ['qext', 'pext', 'vmeas', 'qmeas', 'pmeas'] },
  SexsPti: { label: 'SEXS-PTI', monitors: ['efd'] },
  Signal: { monitors: [] },
  Tgov1: { label: 'TGOV1', monitors: [] },
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

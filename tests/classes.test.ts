import { describe, expect, it } from 'vitest'

import { canonicalMonitor, CLASSES, classLabel, classMonitors } from '../src/gridkit/classes.js'

describe('classes: canonicalMonitor', () => {
  it('matches the catalog case-insensitively and returns the catalog spelling', () => {
    expect(canonicalMonitor('Bus', 'vm')).toBe('Vm')
    expect(canonicalMonitor('Bus', 'VM')).toBe('Vm')
    expect(canonicalMonitor('Bus', 'Vm')).toBe('Vm')
    expect(canonicalMonitor('Bus', 'va')).toBe('Va') // every bus, BusInfinite included
    expect(canonicalMonitor('Genrou', 'IR')).toBe('ir')
    expect(canonicalMonitor('Genrou', 'Speed')).toBe('speed')
    expect(canonicalMonitor('Branch', 'P1')).toBe('p1')
  })

  it('passes a name the catalog does not know through verbatim', () => {
    expect(canonicalMonitor('Bus', 'Zap')).toBe('Zap')
    expect(canonicalMonitor('Genrou', 'Vm')).toBe('Vm') // a bus monitor is not a Genrou one
    expect(canonicalMonitor('FutureGovernor', 'Output')).toBe('Output')
    expect(canonicalMonitor('', 'x')).toBe('x')
  })
})

describe('classes: classLabel', () => {
  it('uses the table label where one exists', () => {
    expect(classLabel('Genrou')).toBe('GENROU')
    expect(classLabel('GastPti')).toBe('GAST-PTI')
    expect(classLabel('LoadZIP')).toBe('LoadZIP')
  })

  it('falls back to the class string for a class without a label or outside the table', () => {
    expect(classLabel('Bus')).toBe('Bus')
    expect(classLabel('Branch')).toBe('Branch')
    expect(classLabel('FutureGovernor')).toBe('FutureGovernor')
  })
})

describe('classes: CLASSES', () => {
  it('covers the classes every case leans on', () => {
    for (const name of ['Bus', 'Branch', 'Genrou']) expect(CLASSES).toHaveProperty(name)
    expect(classMonitors('Bus')).toEqual(['Vr', 'Vi', 'Vm', 'Va'])
    expect(classMonitors('Branch')).toContain('p1')
    expect(classMonitors('Genrou')).toContain('speed')
    expect(classMonitors('Unknown')).toEqual([])
  })

  it('lists each monitor once per class, case-insensitively', () => {
    for (const [name, info] of Object.entries(CLASSES)) {
      const lower = info.monitors.map((monitor) => monitor.toLowerCase())
      expect(new Set(lower).size, `${name} repeats a monitor`).toBe(lower.length)
    }
  })

  it('names every monitor as a bare identifier, and every label as non-empty text', () => {
    for (const [name, info] of Object.entries(CLASSES)) {
      for (const monitor of info.monitors)
        expect(monitor, `${name} monitor ${JSON.stringify(monitor)}`).toMatch(
          /^[A-Za-z][A-Za-z0-9_]*$/,
        )
      if (info.label !== undefined) expect(info.label.trim(), `${name} label`).not.toBe('')
    }
  })
})

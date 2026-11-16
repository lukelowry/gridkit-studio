import { describe, expect, it } from 'vitest'

import { contextKeysIn, evaluateWhen, Menus } from './menus.js'

describe('when clauses, as VS Code reads them', () => {
  it('matches a key while its value is truthy, and negates it', () => {
    expect(evaluateWhen('a', { a: true })).toBe(true)
    expect(evaluateWhen('a', { a: '' })).toBe(false)
    expect(evaluateWhen('a', {})).toBe(false)
    expect(evaluateWhen('!a', {})).toBe(true)
    expect(evaluateWhen('!!a', { a: 1 })).toBe(true)
    expect(evaluateWhen(undefined, {})).toBe(true)
    expect(evaluateWhen('true', {})).toBe(true)
    expect(evaluateWhen('false', {})).toBe(false)
  })
  it('compares values as text, and an absent key equals nothing', () => {
    expect(evaluateWhen('scope == plot', { scope: 'plot' })).toBe(true)
    expect(evaluateWhen('scope == plot', { scope: 'value' })).toBe(false)
    expect(evaluateWhen('sort != ascending', {})).toBe(true)
    expect(evaluateWhen('sort != ascending', { sort: 'ascending' })).toBe(false)
    expect(evaluateWhen("view == 'a.b'", { view: 'a.b' })).toBe(true)
    expect(evaluateWhen('a == true', { a: 'yes' })).toBe(true)
    expect(evaluateWhen('a == false', {})).toBe(true)
  })
  it('binds && before ||, and parentheses first', () => {
    expect(evaluateWhen('a && b || c', { c: true })).toBe(true)
    expect(evaluateWhen('a && (b || c)', { c: true })).toBe(false)
    expect(evaluateWhen('a || b && c', { a: true })).toBe(true)
    expect(evaluateWhen('!a && b', { b: true })).toBe(true)
  })
  it('matches a pattern with its flags', () => {
    expect(evaluateWhen('name =~ /\\.case\\.json$/i', { name: 'X.CASE.JSON' })).toBe(true)
    expect(evaluateWhen('name =~ /\\.case\\.json$/i', { name: 'x.json' })).toBe(false)
  })
  it('refuses a clause it cannot read rather than guessing', () => {
    expect(() => evaluateWhen('a &&', {})).toThrow()
    expect(() => evaluateWhen('(a', {})).toThrow()
    expect(() => evaluateWhen('a b', {})).toThrow()
  })
  it('names the keys a clause reads, not the values it compares them to', () => {
    expect(contextKeysIn('view == x.y && !a || b =~ /c/')).toEqual(['view', 'a', 'b'])
  })
})

describe('Menus', () => {
  const menus = new Menus({
    contributes: {
      commands: [
        { command: 'sort', title: 'Sort Ascending', enablement: 'ready' },
        { command: 'copy', title: 'Copy Value' },
      ],
      menus: {
        'webview/context': [
          { command: 'sort', when: 'scope == column' },
          { command: 'copy', when: 'scope == value' },
        ],
      },
    },
  })
  it('offers the items whose clauses match, by title', () => {
    expect(menus.offered('webview/context', { scope: 'value' })).toEqual([
      { command: 'copy', title: 'Copy Value' },
    ])
    expect(menus.find('webview/context', 'Copy', { scope: 'value' }).command).toBe('copy')
  })
  it('names what a place offers instead of an item it does not', () => {
    expect(() => menus.find('webview/context', 'Sort', { scope: 'value' })).toThrow(/Copy Value/)
  })
  it('enables a command by its enablement', () => {
    expect(menus.enabled('sort', {})).toBe(false)
    expect(menus.enabled('sort', { ready: true })).toBe(true)
    expect(menus.enabled('copy', {})).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'

import { holds, Menus, named } from './menus.js'

describe('when clauses, as VS Code reads them', () => {
  it('holds a key while its value is truthy, and negates it', () => {
    expect(holds('a', { a: true })).toBe(true)
    expect(holds('a', { a: '' })).toBe(false)
    expect(holds('a', {})).toBe(false)
    expect(holds('!a', {})).toBe(true)
    expect(holds('!!a', { a: 1 })).toBe(true)
    expect(holds(undefined, {})).toBe(true)
    expect(holds('true', {})).toBe(true)
    expect(holds('false', {})).toBe(false)
  })
  it('compares values as text, and an absent key equals nothing', () => {
    expect(holds('scope == plot', { scope: 'plot' })).toBe(true)
    expect(holds('scope == plot', { scope: 'value' })).toBe(false)
    expect(holds('sort != ascending', {})).toBe(true)
    expect(holds('sort != ascending', { sort: 'ascending' })).toBe(false)
    expect(holds("view == 'a.b'", { view: 'a.b' })).toBe(true)
    expect(holds('a == true', { a: 'yes' })).toBe(true)
    expect(holds('a == false', {})).toBe(true)
  })
  it('binds && before ||, and parentheses first', () => {
    expect(holds('a && b || c', { c: true })).toBe(true)
    expect(holds('a && (b || c)', { c: true })).toBe(false)
    expect(holds('a || b && c', { a: true })).toBe(true)
    expect(holds('!a && b', { b: true })).toBe(true)
  })
  it('matches a pattern with its flags', () => {
    expect(holds('name =~ /\\.case\\.json$/i', { name: 'X.CASE.JSON' })).toBe(true)
    expect(holds('name =~ /\\.case\\.json$/i', { name: 'x.json' })).toBe(false)
  })
  it('refuses a clause it cannot read rather than guessing', () => {
    expect(() => holds('a &&', {})).toThrow()
    expect(() => holds('(a', {})).toThrow()
    expect(() => holds('a b', {})).toThrow()
  })
  it('names the keys a clause reads, not the values it compares them to', () => {
    expect(named('view == x.y && !a || b =~ /c/')).toEqual(['view', 'a', 'b'])
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
  it('offers what its clauses hold for, by title', () => {
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

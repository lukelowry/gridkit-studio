/** Evaluates the manifest's menus and enablement as VS Code does, so tests can run a command from
 *  where the user finds it without waiting on VS Code's popups. */

export type Keys = Readonly<Record<string, unknown>>

export interface Manifest {
  contributes: {
    commands: readonly { command: string; title: string; enablement?: string }[]
    menus: Readonly<Record<string, readonly { command: string; when?: string; group?: string }[]>>
  }
}

/** A menu entry. Title bars show the `navigation` group as buttons, the rest under More Actions. */
export interface Offered {
  readonly command: string
  readonly title: string
  readonly group?: string
}

const TOKEN =
  /\s*(\|\||&&|==|!=|=~|!|\(|\)|\/(?:\\.|[^/\\])+\/[a-z]*|'[^']*'|"[^"]*"|[^\s!()=&|]+)/y

function tokens(when: string): string[] {
  const out: string[] = []
  TOKEN.lastIndex = 0
  while (TOKEN.lastIndex < when.length) {
    const at = TOKEN.lastIndex
    const match = TOKEN.exec(when)
    if (!match) {
      if (!when.slice(at).trim()) break
      throw new Error(`Cannot read "${when}" at ${at}`)
    }
    out.push(match[1]!)
  }
  return out
}

const literal = (token: string) => token.replace(/^(['"])(.*)\1$/, '$2')

/**
 * Evaluates a when clause against `keys` as VS Code does: `||` binds loosest, then `&&`, then `!`.
 * `==` and `!=` compare as text, except `true` and `false`, which compare the key's truthiness.
 * Supports `=~ /pattern/` and parentheses. An empty clause is true.
 */
export function evaluateWhen(when: string | undefined, keys: Keys): boolean {
  if (!when?.trim()) return true
  const list = tokens(when)
  let i = 0
  const take = (expected?: string) => {
    const token = list[i++]
    if (token === undefined || (expected !== undefined && token !== expected))
      throw new Error(`Cannot read "${when}": expected ${expected ?? 'more'}`)
    return token
  }
  const or = (): boolean => {
    let value = and()
    while (list[i] === '||') {
      take()
      value = and() || value
    }
    return value
  }
  const and = (): boolean => {
    let value = not()
    while (list[i] === '&&') {
      take()
      value = not() && value
    }
    return value
  }
  const not = (): boolean => {
    if (list[i] !== '!') return term()
    take()
    return !not()
  }
  const term = (): boolean => {
    const token = take()
    if (token === '(') {
      const value = or()
      take(')')
      return value
    }
    if (token === 'true') return true
    if (token === 'false') return false
    const value = keys[token]
    const operator = list[i]
    if (operator === '==' || operator === '!=') {
      take()
      const text = literal(take())
      const equal =
        text === 'true'
          ? !!value
          : text === 'false'
            ? !value
            : value !== undefined && value !== null && String(value) === text
      return operator === '==' ? equal : !equal
    }
    if (operator === '=~') {
      take()
      const pattern = take()
      const end = pattern.lastIndexOf('/')
      return new RegExp(pattern.slice(1, end), pattern.slice(end + 1)).test(String(value))
    }
    return !!value
  }
  const value = or()
  if (i !== list.length) throw new Error(`Cannot read "${when}": "${list[i]}" left over`)
  return value
}

/** The context keys a clause references. */
export function contextKeysIn(when: string | undefined): string[] {
  if (!when?.trim()) return []
  const list = tokens(when)
  return list.filter(
    (token, i) =>
      !['||', '&&', '!', '(', ')', '==', '!=', '=~', 'true', 'false'].includes(token) &&
      !['==', '!=', '=~'].includes(list[i - 1] ?? ''),
  )
}

export class Menus {
  readonly #titles: ReadonlyMap<string, string>
  readonly #enablement: ReadonlyMap<string, string | undefined>
  constructor(readonly manifest: Manifest) {
    this.#titles = new Map(manifest.contributes.commands.map((each) => [each.command, each.title]))
    this.#enablement = new Map(
      manifest.contributes.commands.map((each) => [each.command, each.enablement]),
    )
  }
  offered(place: string, keys: Keys): Offered[] {
    return (this.manifest.contributes.menus[place] ?? [])
      .filter((entry) => evaluateWhen(entry.when, keys))
      .map((entry) => ({
        command: entry.command,
        title: this.title(entry.command),
        ...(entry.group && { group: entry.group }),
      }))
  }
  /** The one entry in `place` whose title starts with `title`; otherwise throws, listing all. */
  find(place: string, title: string, keys: Keys): Offered {
    const offered = this.offered(place, keys)
    const found = offered.filter((each) => each.title.startsWith(title))
    if (found.length !== 1)
      throw new Error(
        `${place} offers ${found.length ? 'more than one' : 'no'} "${title}" here, but ` +
          (offered.map((each) => each.title).join(', ') || 'nothing'),
      )
    return found[0]!
  }
  enabled(command: string, keys: Keys): boolean {
    return evaluateWhen(this.#enablement.get(command), keys)
  }
  title(command: string): string {
    const title = this.#titles.get(command)
    if (title === undefined) throw new Error(`${command} has no title`)
    return title
  }
  /** Every when and enablement clause in the manifest, with where it appears. */
  clauses(): { place: string; when: string }[] {
    const out: { place: string; when: string }[] = []
    for (const [place, entries] of Object.entries(this.manifest.contributes.menus))
      for (const entry of entries) if (entry.when) out.push({ place, when: entry.when })
    for (const [command, when] of this.#enablement)
      if (when) out.push({ place: 'enablement of ' + command, when })
    return out
  }
}

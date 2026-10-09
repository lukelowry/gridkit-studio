/** Where Studio's manifest offers its commands, read as VS Code reads it: what a menu, a title bar or
 *  the Command Palette shows in a context, and whether each command there is enabled. The VS Code
 *  suites run a command from where the user finds it through this, so no test waits on VS Code's
 *  own popups; the Native menus suite checks those popups against it. */

/** Context keys and their values, as VS Code holds them. */
export type Keys = Readonly<Record<string, unknown>>

/** The parts of an extension manifest that place commands. */
export interface Manifest {
  contributes: {
    commands: readonly { command: string; title: string; enablement?: string }[]
    menus: Readonly<Record<string, readonly { command: string; when?: string; group?: string }[]>>
  }
}

/** A command as a place offers it, and the group it shows in: a title bar shows its `navigation`
 *  group as buttons, and the rest under More Actions. */
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

/** A literal as VS Code reads it: quotes dropped. */
const literal = (token: string) => token.replace(/^(['"])(.*)\1$/, '$2')

/**
 * Whether `when` holds for `keys`, as VS Code evaluates it: `||` binds loosest, then `&&`, then `!`.
 * A term is a key, which holds while its value is truthy, or `key == value` and `key != value`,
 * which compare the value as text and `true` or `false` as the key's truth, or `key =~ /pattern/`,
 * `true`, `false`, or a clause in parentheses. An absent clause always holds.
 */
export function holds(when: string | undefined, keys: Keys): boolean {
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

/** Every context key a clause names. */
export function named(when: string | undefined): string[] {
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
  /** The commands `place` shows for `keys`, as the manifest lists them. */
  offered(place: string, keys: Keys): Offered[] {
    return (this.manifest.contributes.menus[place] ?? [])
      .filter((entry) => holds(entry.when, keys))
      .map((entry) => ({
        command: entry.command,
        title: this.title(entry.command),
        ...(entry.group && { group: entry.group }),
      }))
  }
  /** What `place` shows for `keys` whose title starts with `title`; throws naming what it shows
   *  instead when it shows none, or more than one. */
  find(place: string, title: string, keys: Keys): Offered {
    const shown = this.offered(place, keys)
    const found = shown.filter((each) => each.title.startsWith(title))
    if (found.length !== 1)
      throw new Error(
        `${place} offers ${found.length ? 'more than one' : 'no'} "${title}" here, but ` +
          (shown.map((each) => each.title).join(', ') || 'nothing'),
      )
    return found[0]!
  }
  /** Whether `command` runs for `keys`: its enablement holds. */
  enabled(command: string, keys: Keys): boolean {
    return holds(this.#enablement.get(command), keys)
  }
  /** The command whose title is `title`, if the Command Palette shows it for `keys`. */
  palette(title: string, keys: Keys): Offered {
    const command = [...this.#titles].find(([, each]) => each === title)?.[0]
    if (!command) throw new Error(`No command is titled "${title}"`)
    const listed = this.manifest.contributes.menus.commandPalette?.find(
      (entry) => entry.command === command,
    )
    if (!holds(listed?.when, keys)) throw new Error(`The Command Palette hides "${title}" here`)
    return { command, title }
  }
  title(command: string): string {
    const title = this.#titles.get(command)
    if (title === undefined) throw new Error(`${command} has no title`)
    return title
  }
  /** Every clause the manifest places a command by, with the place it is in. */
  clauses(): { place: string; when: string }[] {
    const out: { place: string; when: string }[] = []
    for (const [place, entries] of Object.entries(this.manifest.contributes.menus))
      for (const entry of entries) if (entry.when) out.push({ place, when: entry.when })
    for (const [command, when] of this.#enablement)
      if (when) out.push({ place: 'enablement of ' + command, when })
    return out
  }
}

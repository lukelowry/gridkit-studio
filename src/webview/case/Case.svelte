<!-- The Case panel: one type's elements as rows, its fields as columns. Its type and filters are
  chosen from the view's title bar, which also says what shows; a column's menu maps it onto the
  network. -->
<script lang="ts">
  import type { Id } from 'latkit'
  import { onMount, tick } from 'svelte'

  import { channelsOf, shortNames } from '../../shared/bindings.js'
  import {
    changedTable,
    display,
    leaf,
    rowsOf,
    shownColumns,
    shownType,
  } from '../../shared/cells.js'
  import { menuContext } from '../../shared/contexts.js'
  import type { TableRequest } from '../../shared/data.js'
  import {
    type Entity,
    entityKey,
    type FieldDefinition,
    fieldDefinition,
    tableDefinition,
  } from '../../shared/document.js'
  import {
    type Revision,
    revisionOf,
    type TableState,
    type Value,
    type ViewState,
  } from '../../shared/messages.js'
  import { bridge, merged } from '../bridge.js'

  type Row = ReturnType<typeof rowsOf>[number]

  /** Row height in px for virtual scrolling: the --spacing-row-h token. */
  const height = 28
  /** The keys that move between cells. */
  const MOVES = [
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
  ]

  let view = $state.raw<ViewState>({})
  // What the rows are read from, each apart: a message that leaves it as it was, as a selection
  // does, reads nothing again.
  const summary = $derived(view.summary)
  const version = $derived(view.summary?.version)
  const stale = $derived(view.stale)
  /** What the panel shows of its rows: the session's, as it last said, with the changes made here
   *  since applied at once, which the session takes as they are. */
  let table = $state.raw<TableState>({})
  /** The session's table as it last said it, which a state that leaves it as it was keeps. */
  let told: TableState | undefined
  const type = $derived(summary ? (shownType(summary, table) ?? '') : '')
  const fields = $derived(summary && type ? shownColumns(summary, table, type) : [])
  const filter = $derived(table.filter ?? '')
  const equal = $derived(table.equal)
  const order = $derived(table.order)
  /** The first row the panel reads, as it scrolls. */
  let offset = $state(0)
  let total = $state(0)
  let loading = $state(false)
  /** The rows read, and the row they start at: until the next page comes, the last stays where it
   *  was read. */
  let page = $state.raw<{ offset: number; rows: Row[] }>({ offset: 0, rows: [] })
  let editing = $state<
    | { id: Id; field: string; text: string; revision: Revision; row: number; column: number }
    | undefined
  >()
  let scroll: HTMLDivElement
  let generation = 0
  let controller: AbortController | undefined
  /** A cell the keys moved to on a page not yet read, which takes focus once it is. */
  let pending: { row: number; column: number } | undefined
  /** The selected row the panel scrolls to once it is drawn. */
  let revealing: Id | undefined
  /** The last element selected here, which is in sight already. */
  let own: string | undefined
  /** What the rows read are of: another type, filter or order starts them over, at the top. */
  let viewed: { type: string; key: string } | undefined
  const definitions = $derived<Readonly<Record<string, FieldDefinition>>>(
    Object.fromEntries(
      (summary ? (tableDefinition(summary.definition, type)?.fields ?? []) : []).map((field) => [
        field.name,
        field,
      ]),
    ),
  )
  /** The field each row is known by, shown as the row's own header. */
  const identity = $derived(summary?.identities[type])
  /** The type's static fields besides its identity; sampled ones belong to the Monitor. */
  /** A cell as text: a number to six significant digits, which hover and editing show whole. */
  const text = (value: unknown) =>
    typeof value === 'number'
      ? String(Number(value.toPrecision(6)))
      : display(value, { native: true })
  /** The channels each mapped column drives. */
  const mapped = $derived(
    new Map(
      fields.flatMap((field) => {
        const channels = channelsOf(view.bindings ?? {}, { table: type, field })
        return channels.length ? [[field, shortNames(channels)] as const] : []
      }),
    ),
  )
  /** The cell Tab enters the grid at: the selection's, or its row's first, else the first. */
  const anchor = $derived.by(() => {
    const at = page.rows.findIndex((row) => row.id === view.selection?.id)
    return {
      row: page.offset + Math.max(at, 0),
      column: at < 0 ? 0 : Math.max(fields.indexOf(view.selection?.field ?? ''), 0),
    }
  })
  const context = (id: Id | null, field?: string) =>
    summary
      ? JSON.stringify(
          menuContext(
            summary,
            {
              uri: summary.uri,
              version: summary.version,
              origin: 'case',
              type,
              field,
              ...(id !== null ? { element: { table: type, id, ...(field ? { field } : {}) } } : {}),
            },
            view.bindings,
            // The panel's own view of its rows, for the items that change it.
            { sort: order, filtered: !!(filter || equal) },
          ),
        )
      : '{}'
  /** Gives the header, row or cell right-clicked its menu's context as the menu opens, before VS
   *  Code reads it, so the rows need not carry one each. */
  function contextmenu(event: MouseEvent) {
    const target = (event.target as Element | null)?.closest<HTMLElement>('[data-field], [data-id]')
    if (!target || !scroll?.contains(target)) return
    const encoded = target.closest<HTMLElement>('[data-id]')?.dataset.id
    const id: Id | null = encoded ? JSON.parse(encoded) : null
    target.dataset.vscodeContext = context(id, target.dataset.field)
    setTimeout(() => delete target.dataset.vscodeContext)
  }
  /** Changes what the panel shows, here at once, and in the session, which holds it. */
  function change(next: Partial<TableState>) {
    table = changedTable(summary, table, next)
    bridge.send({ kind: 'table', change: next })
  }
  const cellAt = (row: number, column: number) =>
    scroll?.querySelector<HTMLButtonElement>(`[data-row="${row}"][data-column="${column}"]`)
  /** Focus the cell at `row`, `column`, which selects its element as a click does, so the Network
   *  follows. */
  function focusCell(row: number, column: number) {
    cellAt(row, column)?.focus()
    select(page.rows[row - page.offset]?.id ?? null, fields[column])
  }
  /** Moves from the cell at `row`, `column` as `event`'s key says: a cell, a screen of rows, or, with
   *  Ctrl, to the first or last cell. A cell on a page not yet read is focused once it is. */
  function move(event: KeyboardEvent, row: number, column: number) {
    const { key } = event
    if (!MOVES.includes(key)) return
    event.preventDefault()
    const ends = (event.ctrlKey || event.metaKey) && (key === 'Home' || key === 'End')
    const screen = Math.max(1, Math.floor(scroll.clientHeight / height) - 1)
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: screen, PageUp: -screen }[key] ?? 0
    const within = (n: number, last: number) => Math.max(0, Math.min(last, n))
    const nextRow = within(ends ? (key === 'Home' ? 0 : total - 1) : row + step, total - 1)
    const nextColumn = within(
      key === 'Home'
        ? 0
        : key === 'End'
          ? fields.length - 1
          : column + (key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0),
      fields.length - 1,
    )
    if (nextRow < page.offset || nextRow >= page.offset + page.rows.length) {
      pending = { row: nextRow, column: nextColumn }
      offset = Math.max(0, nextRow - 10)
      scroll.scrollTop = nextRow * height
      return
    }
    focusCell(nextRow, nextColumn)
  }
  async function load() {
    controller?.abort()
    if (!summary || stale) return
    const request = (controller = new AbortController())
    const current = ++generation
    const at = offset
    // The rows are of the revision on show now, whatever the panel shows by the time they come.
    const revision = revisionOf(summary)
    loading = true
    try {
      const query: TableRequest = {
        table: type,
        fields,
        offset: at,
        limit: 100,
        ...(filter ? { search: filter } : {}),
        ...(equal ? { equal } : {}),
        ...(order ? { order } : {}),
      }
      const result = await bridge.request(
        'page',
        { revision, request: $state.snapshot(query) },
        request.signal,
      )
      if (generation !== current) return
      page = { offset: result.offset, rows: rowsOf(result) }
      total = result.total
      // The view's title says how many rows the filters leave.
      bridge.send({ kind: 'rows', shown: total })
      await tick()
      if (pending && pending.row >= at && pending.row < at + page.rows.length) {
        focusCell(pending.row, pending.column)
        pending = undefined
      }
      scrolled()
    } catch (reason) {
      if (generation === current && !request.signal.aborted) bridge.report(reason)
    } finally {
      if (generation === current) loading = false
    }
  }
  $effect(() => {
    generation++
    void version
    void stale
    void type
    void offset
    void fields
    void filter
    void equal
    void order
    const timer = setTimeout(() => {
      void load()
    }, 60)
    return () => {
      clearTimeout(timer)
      controller?.abort()
    }
  })
  // Another type, filter or order reads its rows from the top; another type's rows go at once, and
  // its own load in a moment.
  $effect.pre(() => {
    const key = JSON.stringify([type, filter, equal, order])
    if (viewed?.key === key) return
    if (viewed) {
      if (viewed.type !== type) page = { offset: 0, rows: [] }
      offset = 0
      if (scroll) scroll.scrollTop = 0
    }
    viewed = { type, key }
  })
  /** Order the rows by `field`, the other way from now. */
  function sort(field: string) {
    change({
      order: {
        field,
        direction:
          order?.field === field && order.direction === 'ascending' ? 'descending' : 'ascending',
      },
    })
  }
  function select(id: Id | null, field?: string) {
    if (id === null) return
    own = entityKey({ table: type, id })
    bridge.send({ kind: 'select', element: { table: type, id, ...(field ? { field } : {}) } })
  }
  function edit(id: Id | null, field: string, value: unknown, row: number, column: number) {
    if (id === null || stale || !view.writable || !summary?.editable[type]?.includes(field)) return
    const spec = fieldDefinition(summary.definition, type, field)
    editing = {
      id,
      field,
      row,
      column,
      revision: revisionOf(summary),
      text:
        spec?.kind === 'text'
          ? String(value ?? '')
          : spec?.kind === 'reference'
            ? value && typeof value === 'object' && 'id' in value
              ? String(value.id ?? '')
              : ''
            : JSON.stringify(value),
    }
  }
  function focus(input: HTMLInputElement) {
    input.focus()
    input.select()
  }
  async function commit() {
    const edit = editing
    if (!edit || !summary) return
    editing = undefined
    try {
      const spec = fieldDefinition(summary.definition, type, edit.field)!
      const value: Value =
        spec.kind === 'text'
          ? edit.text
          : spec.kind === 'reference'
            ? edit.text.trim() === 'null' || !edit.text.trim()
              ? null
              : Number.isSafeInteger(Number(edit.text))
                ? Number(edit.text)
                : edit.text
            : JSON.parse(edit.text)
      await bridge.request('transact', {
        // The edit's state is reactive; a message carries plain values.
        revision: $state.snapshot(edit.revision),
        mutations: [
          { kind: 'set', entity: { table: type, id: edit.id }, field: edit.field, value },
        ],
        label: 'Edit ' + leaf(edit.field),
      })
    } catch (reason) {
      bridge.report(reason)
    }
  }
  /** Ends the edit from its keys, keeping or dropping it, and goes back to its cell. */
  async function close(keep: boolean) {
    const edit = editing
    if (!edit) return
    if (keep) void commit()
    else editing = undefined
    await tick()
    cellAt(edit.row, edit.column)?.focus()
  }
  /** Scroll the selected row into view once it is drawn; whether it was. */
  function scrolled(): boolean {
    const shown = revealing !== undefined && scroll?.querySelector('tr.selected')
    if (!shown) return false
    shown.scrollIntoView({ block: 'nearest' })
    revealing = undefined
    return true
  }
  /** Show the selected element's row: switch to its type, and scroll the row into view, now or
   *  once the page holding it loads. */
  async function reveal(entity: Entity) {
    const { id, table: next } = entity
    const of = view.uri
    revealing = id
    if (next !== type) change({ type: next })
    await tick()
    if (scrolled()) return
    // A row the filters leave out shows once they go.
    if (filter || equal || order) change({ filter: undefined, equal: undefined, order: undefined })
    try {
      if (!summary) return
      const result = await bridge.request('page', {
        revision: revisionOf(summary),
        request: { table: next, fields: [], offset: 0, limit: 1, anchor: id },
      })
      if (view.uri === of && view.selection?.table === next && view.selection.id === id)
        offset = result.offset
    } catch (reason) {
      bridge.report(reason)
    }
  }
  onMount(() => {
    const stop = bridge.on((message) => {
      if (message.kind === 'state') {
        const other = message.state.uri !== view.uri
        // The selection the panel had in sight: none of a case it has yet to read.
        const before =
          other || !view.summary || !view.selection ? undefined : entityKey(view.selection)
        view = merged(view, message.state)
        // Another case's rows go with it; its own load once it reads.
        if (other) {
          controller?.abort()
          page = { offset: 0, rows: [] }
          total = 0
        }
        // What the session says the panel shows, as it changes there: by a command, or as the
        // session took a change made here.
        if (other || view.table !== told) {
          told = view.table
          table = view.table ?? {}
        }
        // A selection made in another view is brought into sight, its type shown; one made here
        // already is.
        const selected = view.selection ? entityKey(view.selection) : undefined
        if (selected && selected !== before && selected !== own && view.summary && !view.stale)
          void reveal(view.selection!)
        if (selected !== own) own = undefined
      }
    })
    // Before VS Code, and anything else, reads what a right-click carries.
    window.addEventListener('contextmenu', contextmenu, true)
    bridge.ready()
    return () => {
      stop()
      window.removeEventListener('contextmenu', contextmenu, true)
      controller?.abort()
    }
  })
</script>

<main class="case">
  <div
    class="case__scroll"
    bind:this={scroll}
    onscroll={() => {
      const next = Math.max(0, Math.floor(scroll.scrollTop / height) - 10)
      if (Math.abs(next - offset) >= 10) offset = next
    }}
  >
    <table aria-label={type + ' fields'} aria-rowcount={total + 1}>
      <thead>
        <tr>
          <th scope="col">{identity ?? ''}</th>
          {#each fields as field (field)}
            {@const unit = definitions[field]?.unit}
            <th
              scope="col"
              aria-sort={order?.field === field ? order.direction : 'none'}
              data-field={field}
            >
              <button onclick={() => sort(field)} title={field}>
                {leaf(field)}{#if unit && leaf(field).toLowerCase() !== unit.toLowerCase()}<span
                    class="case__unit"
                  >
                    {unit}
                  </span>{/if}{#if mapped.has(field)}<span class="case__mapped">
                    {mapped.get(field)}
                  </span>{/if}{#if order?.field === field}<span
                    class="case__sort"
                    aria-hidden="true"
                  >
                    {order.direction === 'ascending' ? '↑' : '↓'}
                  </span>{/if}
              </button>
            </th>
          {/each}
          <th class="case__fill" aria-hidden="true"></th>
        </tr>
      </thead>
      <tbody>
        {#if page.offset > 0}<tr aria-hidden="true">
            <td
              colspan={fields.length + 2}
              style:height={page.offset * height + 'px'}
              class="spacer"
            ></td>
          </tr>{/if}
        {#each page.rows as row, rowIndex (row.id)}
          <tr
            class:selected={view.selection?.table === type && view.selection.id === row.id}
            aria-rowindex={page.offset + rowIndex + 2}
            data-id={JSON.stringify(row.id)}
          >
            <th scope="row">
              <button tabindex="-1" onclick={() => select(row.id)} title={String(row.id)}>
                {String(row.id)}
              </button>
            </th>
            {#each fields as field, columnIndex (field)}
              <td data-field={field} class:numeric={typeof row.values[field] === 'number'}>
                {#if editing?.id === row.id && editing.field === field}
                  <input
                    use:focus
                    aria-label={'Edit ' + leaf(field)}
                    bind:value={editing.text}
                    onkeydown={(event) => {
                      if (event.key === 'Enter' || event.key === 'Escape') {
                        event.preventDefault()
                        void close(event.key === 'Enter')
                      }
                    }}
                    onblur={() => void commit()}
                    placeholder={definitions[field]?.kind === 'reference' ? 'ID or null' : ''}
                  />
                {:else}
                  <button
                    class="cell"
                    data-row={page.offset + rowIndex}
                    data-column={columnIndex}
                    tabindex={page.offset + rowIndex === anchor.row && columnIndex === anchor.column
                      ? 0
                      : -1}
                    onclick={() => select(row.id, field)}
                    ondblclick={() =>
                      edit(row.id, field, row.values[field], page.offset + rowIndex, columnIndex)}
                    onkeydown={(event) => {
                      if (event.key === 'Enter' || event.key === 'F2') {
                        event.preventDefault()
                        edit(row.id, field, row.values[field], page.offset + rowIndex, columnIndex)
                      } else move(event, page.offset + rowIndex, columnIndex)
                    }}
                    title={(typeof row.values[field] === 'number'
                      ? String(row.values[field]) + '. '
                      : '') +
                      'Double-click or press F2 to edit ' +
                      leaf(field)}
                  >
                    {text(row.values[field])}
                  </button>
                {/if}
              </td>
            {/each}
            <td class="case__fill" aria-hidden="true"></td>
          </tr>
        {/each}
        {#if total > page.offset + page.rows.length}<tr aria-hidden="true">
            <td
              colspan={fields.length + 2}
              style:height={(total - page.offset - page.rows.length) * height + 'px'}
              class="spacer"
            ></td>
          </tr>{/if}
      </tbody>
    </table>
    {#if view.uri && ((!summary && !view.error) || (summary && !total && !loading))}
      <div class="c-empty">
        <p class="c-empty__text">{summary ? 'No matching elements.' : 'Loading case…'}</p>
      </div>
    {/if}
  </div>
</main>

<style>
  .case {
    display: flex;
    flex-direction: column;
    block-size: 100%;
  }
  /* The spacers above and below the page of rows change size as pages load; anchoring the scroll
     to the rows would move it, and the move would load another page. */
  .case__scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overflow-anchor: none;
  }
  /* Columns as wide as what they hold; the last, empty one takes what is left of the panel. */
  table {
    border-collapse: separate;
    border-spacing: 0;
    width: max-content;
    min-width: 100%;
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  thead {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--color-surface-1);
  }
  th,
  td {
    height: var(--spacing-row-h);
    padding: 0 var(--spacing-xs);
    border-bottom: 1px solid var(--color-border);
    text-align: left;
    font-weight: normal;
  }
  thead th {
    color: var(--color-text-2);
    font-weight: 600;
  }
  .case__unit,
  .case__mapped {
    margin-inline-start: var(--spacing-xs);
    font-weight: normal;
  }
  .case__unit {
    color: var(--color-text-2);
  }
  .case__mapped {
    color: var(--color-primary-text);
  }
  .case__sort {
    margin-inline-start: var(--spacing-2xs);
    color: var(--color-text-1);
  }
  th button,
  .cell {
    display: block;
    width: 100%;
    min-height: var(--spacing-row-h);
    max-width: 28rem;
    padding: var(--spacing-xs);
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  .cell:hover {
    background: var(--color-row-hover);
  }
  /* The selected row takes VS Code's list selection, and on its header the accent the Network and
     Diagram glow the selection in. */
  tbody tr.selected > * {
    background: var(--color-selected);
  }
  .case:focus-within tbody tr.selected > * {
    background: var(--vscode-list-activeSelectionBackground, var(--color-selected));
    color: var(--vscode-list-activeSelectionForeground, inherit);
  }
  tbody tr.selected > th {
    box-shadow: inset 2px 0 0 var(--color-focus-ring);
  }
  td input {
    width: 100%;
    min-width: 7rem;
    min-height: var(--spacing-row-h);
    padding-inline: var(--spacing-xs);
    border: 1px solid var(--vscode-input-border, var(--color-border));
    border-radius: var(--radius-sm);
    background: var(--color-input);
    color: var(--vscode-input-foreground, var(--color-text-1));
  }
  .spacer {
    padding: 0;
    border: 0;
  }
  .case__fill {
    width: 100%;
    padding: 0;
  }
  tbody th {
    position: sticky;
    left: 0;
    border-right: 1px solid var(--color-border);
    background: var(--color-surface-1);
  }
  .numeric .cell {
    font-family: var(--font-mono);
    text-align: right;
  }
  .cell:focus-visible {
    outline-offset: calc(-1 * var(--focus-width));
    background: var(--vscode-list-focusBackground, var(--color-row-hover));
  }
</style>

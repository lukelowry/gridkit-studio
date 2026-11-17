<!-- The Case panel: one element type's rows and field columns, virtually scrolled. -->
<script lang="ts">
  import type { Id } from 'latkit'
  import { onMount, tick } from 'svelte'

  import {
    cellText,
    changedTable,
    emptyText,
    grown,
    rowsOf,
    shownColumns,
    shownType,
  } from '../../shared/cells.js'
  import type { TableRequest } from '../../shared/data.js'
  import {
    type Entity,
    entityKey,
    type FieldDefinition,
    leaf,
    tableDefinition,
    tableLabel,
  } from '../../shared/document.js'
  import { channelsOf, shortNames } from '../../shared/mappings.js'
  import { menuContext } from '../../shared/menus.js'
  import { revisionOf, type TableState, type ViewState } from '../../shared/messages.js'
  import { bridge } from '../bridge.js'

  type Row = ReturnType<typeof rowsOf>[number]

  /** Row height in CSS pixels: the --spacing-row-h token, which each row is, border included. */
  const ROW_HEIGHT = 28
  const MOVE_KEYS = [
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
  ]

  let viewState = $state.raw<ViewState>({})
  // Separate deriveds, so a message that leaves these unchanged (a selection) reloads nothing.
  const summary = $derived(viewState.summary)
  const version = $derived(viewState.summary?.version)
  const stale = $derived(viewState.stale)
  /** The session's table with local changes applied immediately; the session accepts them as is. */
  let table = $state.raw<TableState>({})
  let sessionTable: TableState | undefined
  const type = $derived(summary ? (shownType(summary, table) ?? '') : '')
  const fields = $derived(summary && type ? shownColumns(summary, table, type) : [])
  const filter = $derived(table.filter ?? '')
  const equal = $derived(table.equal)
  const order = $derived(table.order)
  let offset = $state(0)
  let total = $state(0)
  let reportedTotal: number | undefined
  let viewport = $state(0)
  /** Rows per page: those visible plus a scroll margin, at least 100. */
  const limit = $derived(Math.max(100, Math.ceil(viewport / ROW_HEIGHT) + 40))
  let loading = $state(false)
  /** Whether the last page asked for arrived. A page that failed says nothing about the rows. */
  let answered = $state(false)
  /** The widest each column has measured, by type and field. A column takes the width of the rows
   *  rendered, so without a floor it would resize as other rows scroll into view. */
  let widths = $state.raw<Readonly<Record<string, number>>>({})
  const widthKey = (field = '') => JSON.stringify([type, field])
  const widthOf = (field?: string) => {
    const width = widths[widthKey(field)]
    return width ? width + 'px' : null
  }
  let page = $state.raw<{ offset: number; rows: Row[] }>({ offset: 0, rows: [] })
  let scroll: HTMLDivElement
  let generation = 0
  let controller: AbortController | undefined
  let pendingFocus: { row: number; column: number } | undefined
  let revealing: Id | undefined
  /** The element last selected in this panel, which is already in view. */
  let selectedHere: string | undefined
  let lastQuery: { type: string; key: string } | undefined
  const definitions = $derived<Readonly<Record<string, FieldDefinition>>>(
    Object.fromEntries(
      (summary ? (tableDefinition(summary.definition, type)?.fields ?? []) : []).map((field) => [
        field.name,
        field,
      ]),
    ),
  )
  /** Column headers: the field's last segment, or its full path where two shown fields share one,
   *  as a bus's `ports_in.vr` and `ports_out.vr` do. */
  const headers = $derived.by(() => {
    const shared = new Map<string, number>()
    for (const field of fields) shared.set(leaf(field), (shared.get(leaf(field)) ?? 0) + 1)
    return new Map(
      fields.map((field) => [field, shared.get(leaf(field))! > 1 ? field : leaf(field)]),
    )
  })
  const identity = $derived(summary?.identities[type])
  const typeLabel = $derived(summary && type ? tableLabel(summary.definition, type) : '')
  const corner = $derived.by(() => {
    if (!summary || !type) return ''
    const count = (summary.counts[type] ?? 0).toLocaleString()
    return `${typeLabel} · ${filter || equal ? `${total.toLocaleString()} of ${count}` : count}`
  })
  const empty = $derived(
    emptyText({
      open: !!viewState.uri,
      read: !!summary,
      unreadable: !!viewState.error,
      rows: total,
      loading,
      answered,
      filtered: !!(filter || equal),
    }),
  )
  const mapped = $derived(
    new Map(
      fields.flatMap((field) => {
        const channels = channelsOf(viewState.mappings ?? {}, { table: type, field })
        return channels.length ? [[field, shortNames(channels)] as const] : []
      }),
    ),
  )
  /** The cell Tab enters the grid at: the selected cell, its row's first, or the first. */
  const anchor = $derived.by(() => {
    const at = page.rows.findIndex((row) => row.id === viewState.selection?.id)
    return {
      row: page.offset + Math.max(at, 0),
      column: at < 0 ? 0 : Math.max(fields.indexOf(viewState.selection?.field ?? ''), 0),
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
              ...(field && { field: { table: type, field } }),
              ...(id !== null && { element: { table: type, id } }),
            },
            { mappings: viewState.mappings, sort: order, filtered: !!(filter || equal) },
          ),
        )
      : '{}'
  /** Sets the menu context on the right-clicked header, row or cell just before VS Code reads it,
   *  so the rows need not each carry one. */
  function contextmenu(event: MouseEvent) {
    const target = (event.target as Element | null)?.closest<HTMLElement>('[data-field], [data-id]')
    if (!target || !scroll?.contains(target)) return
    const encoded = target.closest<HTMLElement>('[data-id]')?.dataset.id
    const id: Id | null = encoded ? JSON.parse(encoded) : null
    target.dataset.vscodeContext = context(id, target.dataset.field)
    setTimeout(() => delete target.dataset.vscodeContext)
  }
  function change(next: Partial<TableState>) {
    table = changedTable(summary, table, next)
    bridge.send({ kind: 'table', change: next })
  }
  const cellAt = (row: number, column: number) =>
    scroll?.querySelector<HTMLButtonElement>(`[data-row="${row}"][data-column="${column}"]`)
  function focusCell(row: number, column: number) {
    cellAt(row, column)?.focus()
    select(page.rows[row - page.offset]?.id ?? null, fields[column])
  }
  /** A cell on a page not yet loaded is focused once the page loads. */
  function move(event: KeyboardEvent, row: number, column: number) {
    const { key } = event
    if (!MOVE_KEYS.includes(key)) return
    event.preventDefault()
    const ends = (event.ctrlKey || event.metaKey) && (key === 'Home' || key === 'End')
    const screen = Math.max(1, Math.floor(scroll.clientHeight / ROW_HEIGHT) - 1)
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
      pendingFocus = { row: nextRow, column: nextColumn }
      offset = Math.max(0, nextRow - 10)
      scroll.scrollTop = nextRow * ROW_HEIGHT
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
    // Request rows of the revision shown now, whatever is shown by the time they arrive.
    const revision = revisionOf(summary)
    loading = true
    try {
      const query: TableRequest = {
        table: type,
        fields,
        offset: at,
        limit,
        ...(filter ? { search: filter } : {}),
        ...(equal ? { equal } : {}),
        ...(order ? { order } : {}),
      }
      const result = await bridge.request('page', { revision, request: query }, request.signal)
      if (generation !== current) return
      page = { offset: result.offset, rows: rowsOf(result) }
      total = result.total
      answered = true
      // The view's title shows the filtered row count.
      if (total !== reportedTotal) bridge.send({ kind: 'rows', total: (reportedTotal = total) })
      await tick()
      measure()
      if (pendingFocus && pendingFocus.row >= at && pendingFocus.row < at + page.rows.length) {
        focusCell(pendingFocus.row, pendingFocus.column)
        pendingFocus = undefined
      }
      scrollToSelected()
    } catch (reason) {
      if (generation === current && !request.signal.aborted) {
        answered = false
        bridge.report(reason)
      }
    } finally {
      if (generation === current) loading = false
    }
  }
  /** Keeps each column at least as wide as it has been. */
  function measure() {
    const measured: Record<string, number> = {}
    for (const header of scroll?.querySelectorAll<HTMLElement>('thead th:not(.case__fill)') ?? [])
      measured[widthKey(header.dataset.field)] = Math.ceil(header.getBoundingClientRect().width)
    widths = grown(widths, measured)
  }
  $effect(() => {
    generation++
    void version
    void stale
    void type
    void offset
    void limit
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
  // A new type, filter or order reloads from the top; a new type also clears the old rows at once.
  $effect.pre(() => {
    const key = JSON.stringify([type, filter, equal, order])
    if (lastQuery?.key === key) return
    if (lastQuery) {
      if (lastQuery.type !== type) page = { offset: 0, rows: [] }
      offset = 0
      if (scroll) scroll.scrollTop = 0
    }
    lastQuery = { type, key }
  })
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
    selectedHere = entityKey({ table: type, id })
    bridge.send({ kind: 'select', element: { table: type, id, ...(field ? { field } : {}) } })
  }
  function scrollToSelected(): boolean {
    const row = revealing !== undefined && scroll?.querySelector('tr.selected')
    if (!row) return false
    row.scrollIntoView({ block: 'nearest' })
    revealing = undefined
    return true
  }
  /** Shows the selected element's row: switches to its type and scrolls to the row once its page
   *  loads. Clears the filters only when they hide the row. */
  async function reveal(entity: Entity) {
    const { id, table: nextType } = entity
    const uri = viewState.uri
    revealing = id
    if (nextType !== type) change({ type: nextType })
    await tick()
    if (scrollToSelected()) return
    try {
      if (!summary) return
      const revision = revisionOf(summary)
      const locate = (filtered: boolean) =>
        bridge.request('page', {
          revision,
          request: {
            table: nextType,
            fields: [],
            offset: 0,
            limit: 1,
            anchor: id,
            ...(filtered && filter ? { search: filter } : {}),
            ...(filtered && equal ? { equal } : {}),
            ...(order ? { order } : {}),
          },
        })
      let result = await locate(true)
      if (!result.anchored && (filter || equal)) {
        change({ filter: undefined, equal: undefined })
        result = await locate(false)
      }
      if (
        viewState.uri === uri &&
        viewState.selection?.table === nextType &&
        viewState.selection.id === id
      )
        offset = result.offset
    } catch (reason) {
      bridge.report(reason)
    }
  }
  onMount(() => {
    const stop = bridge.on((message) => {
      if (message.kind === 'state') {
        const otherCase = message.state.uri !== viewState.uri
        // The selection already in view; none for a case not yet loaded.
        const before =
          otherCase || !viewState.summary || !viewState.selection
            ? undefined
            : entityKey(viewState.selection)
        viewState = message.state
        if (otherCase) {
          controller?.abort()
          page = { offset: 0, rows: [] }
          total = 0
          answered = false
          widths = {}
        }
        // Adopt the session's table when it changes there, by a command or a change made here.
        if (otherCase || viewState.table !== sessionTable) {
          sessionTable = viewState.table
          table = viewState.table ?? {}
        }
        // Reveal a selection made in another view; one made here is already in view.
        const selected = viewState.selection ? entityKey(viewState.selection) : undefined
        if (
          selected &&
          selected !== before &&
          selected !== selectedHere &&
          viewState.summary &&
          !viewState.stale
        )
          void reveal(viewState.selection!)
        if (selected !== selectedHere) selectedHere = undefined
      }
    })
    // Capture phase, so the context is set before VS Code reads it.
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
    bind:clientHeight={viewport}
    onscroll={() => {
      const next = Math.max(0, Math.floor(scroll.scrollTop / ROW_HEIGHT) - 10)
      if (Math.abs(next - offset) >= 10) offset = next
    }}
  >
    <table aria-label={type + ' fields'} aria-rowcount={total + 1}>
      <thead>
        <tr>
          <th
            scope="col"
            class="case__corner"
            style:min-width={widthOf()}
            title={identity && `${typeLabel} ${identity}`}
          >
            {corner}
          </th>
          {#each fields as field (field)}
            {@const unit = definitions[field]?.unit}
            <th
              scope="col"
              aria-sort={order?.field === field ? order.direction : 'none'}
              data-field={field}
              style:min-width={widthOf(field)}
            >
              <button onclick={() => sort(field)} title={field}>
                {headers.get(
                  field,
                )}{#if unit && leaf(field).toLowerCase() !== unit.toLowerCase()}<span
                    class="case__unit"
                  >
                    [{unit}]
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
              style:height={page.offset * ROW_HEIGHT + 'px'}
              class="spacer"
            ></td>
          </tr>{/if}
        {#each page.rows as row, rowIndex (row.id)}
          <tr
            class:selected={viewState.selection?.table === type &&
              viewState.selection.id === row.id}
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
                <button
                  class="cell"
                  data-row={page.offset + rowIndex}
                  data-column={columnIndex}
                  tabindex={page.offset + rowIndex === anchor.row && columnIndex === anchor.column
                    ? 0
                    : -1}
                  onclick={() => select(row.id, field)}
                  onkeydown={(event) => move(event, page.offset + rowIndex, columnIndex)}
                  title={typeof row.values[field] === 'number'
                    ? String(row.values[field])
                    : undefined}
                >
                  {cellText(row.values[field])}
                </button>
              </td>
            {/each}
            <td class="case__fill" aria-hidden="true"></td>
          </tr>
        {/each}
        {#if total > page.offset + page.rows.length}<tr aria-hidden="true">
            <td
              colspan={fields.length + 2}
              style:height={(total - page.offset - page.rows.length) * ROW_HEIGHT + 'px'}
              class="spacer"
            ></td>
          </tr>{/if}
      </tbody>
    </table>
    {#if empty}
      <div class="c-empty"><p class="c-empty__text">{empty}</p></div>
    {/if}
  </div>
</main>

<style>
  .case {
    display: flex;
    flex-direction: column;
    block-size: 100%;
  }
  /* The spacers resize as pages load; scroll anchoring would shift the position and load another
     page. */
  .case__scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overflow-anchor: none;
  }
  /* Columns size to their content; the empty last column fills the rest. */
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
  /* A cell's height includes its border, so its button leaves the border's pixel free. */
  th button,
  .cell {
    display: block;
    width: 100%;
    min-height: calc(var(--spacing-row-h) - 1px);
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
  tbody tr.selected > * {
    background: var(--color-selected);
  }
  .case:focus-within tbody tr.selected > * {
    background: var(--vscode-list-activeSelectionBackground, var(--color-selected));
    color: var(--vscode-list-activeSelectionForeground, inherit);
  }
  /* The accent the Network highlights the selection in. */
  tbody tr.selected > th {
    box-shadow: inset 2px 0 0 var(--color-focus-ring);
  }
  .spacer {
    padding: 0;
    border: 0;
  }
  .case__fill {
    width: 100%;
    padding: 0;
  }
  tbody th,
  .case__corner {
    position: sticky;
    left: 0;
    border-right: 1px solid var(--color-border);
    background: var(--color-surface-1);
  }
  .case__corner {
    z-index: 2;
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

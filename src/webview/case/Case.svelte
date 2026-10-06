<!-- The Case panel: one type's elements as rows, its fields as columns. Its type and filters are
  chosen from the view's title bar, which also says what shows; a column's menu maps it onto the
  network. -->
<script lang="ts">
  import type { FieldDefinition, RowsQuery, Value } from '@latkit/model'
  import { onMount, tick } from 'svelte'

  import { channelsOf, shortNames } from '../../shared/bindings.js'
  import { display, leaf, native, referenceNames, rowsOf } from '../../shared/cells.js'
  import { menuContext } from '../../shared/contexts.js'
  import type { TableState, ViewState } from '../../shared/messages.js'
  import { elementType, isReference, unitOf } from '../../shared/schema.js'
  import { bridge, merged } from '../bridge.js'
  import { appearance } from '../theme.js'

  /** How many columns a type shows until the user picks them. */
  const COLUMNS = 12
  /** Row height in px for virtual scrolling: the --spacing-row-h token. */
  const height = 28

  let view = $state<ViewState>({})
  let type = $state(bridge.state({ type: 'Bus' }).type)
  let fields = $state<string[]>([])
  /** The columns chosen for each type, kept as the panel follows a selection between types. */
  let columns = $state<Record<string, string[]>>({})
  let filter = $state('')
  let equal = $state<TableState['equal']>()
  let order = $state<{ field: string; direction: 'ascending' | 'descending' } | undefined>()
  let offset = $state(0)
  let total = $state(0)
  let loading = $state(false)
  let rows = $state<ReturnType<typeof rowsOf>>([])
  let editing = $state<{ id: string; field: string; text: string; version: number } | undefined>()
  let scroll: HTMLDivElement
  let generation = 0
  let controller: AbortController | undefined
  /** The selected row the panel scrolls to once it is drawn. */
  let revealing: string | undefined
  /** The last element selected here, which is in sight already. */
  let own: string | undefined
  const definitions = $derived<Readonly<Record<string, FieldDefinition>>>(
    view.summary?.schema.types[type]?.fields ?? {},
  )
  /** The field each row is known by, shown as the row's own header. */
  const identity = $derived(view.summary?.identities[type])
  /** The type's static fields besides its identity; sampled ones belong to the Monitor. */
  const allFields = $derived(
    Object.keys(definitions).filter((field) => !definitions[field]?.sampled && field !== identity),
  )
  /** A cell as text: a number to six significant digits, which hover and editing show whole. */
  const text = (value: unknown) =>
    typeof value === 'number'
      ? String(Number(value.toPrecision(6)))
      : display(value, { native: true })
  /** The channels each mapped column drives. */
  const mapped = $derived(
    new Map(
      fields.flatMap((field) => {
        const channels = channelsOf(view.bindings ?? {}, { type, field })
        return channels.length ? [[field, shortNames(channels)] as const] : []
      }),
    ),
  )
  const context = (id: string | null, field?: string) =>
    view.summary
      ? JSON.stringify({
          ...menuContext(
            view.summary,
            {
              uri: view.summary.uri,
              version: view.summary.version,
              origin: 'case',
              type,
              field,
              ...(id ? { element: { id, ...(field ? { field } : {}) } } : {}),
            },
            view.bindings,
          ),
          // The panel's own view of its rows, for the items that change it.
          gridkitSort: field && order?.field === field ? order.direction : '',
          gridkitFiltered: !!(filter || equal),
        })
      : '{}'
  const persist = () =>
    bridge.send({
      kind: 'tableState',
      table: {
        type,
        columns: $state.snapshot(columns),
        filter,
        ...(equal && { equal: $state.snapshot(equal) }),
      },
      shown: total,
    })
  /** Show `next` as the type's columns, and keep them for it. */
  function show(next: string[]) {
    fields = next.filter((field) => allFields.includes(field))
    columns[type] = fields
    persist()
  }
  async function move(event: KeyboardEvent, row: number, column: number) {
    const key = event.key
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return
    event.preventDefault()
    const nextRow = Math.max(
      0,
      Math.min(total - 1, row + (key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0)),
    )
    const nextColumn = Math.max(
      0,
      Math.min(
        fields.length - 1,
        key === 'Home'
          ? 0
          : key === 'End'
            ? fields.length - 1
            : column + (key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0),
      ),
    )
    if (nextRow < offset || nextRow >= offset + rows.length) {
      offset = Math.max(0, nextRow - 10)
      scroll.scrollTop = nextRow * height
      await load()
    }
    await tick()
    scroll
      .querySelector<HTMLButtonElement>(
        '[data-row="' + nextRow + '"][data-column="' + nextColumn + '"]',
      )
      ?.focus()
    // The keys move the selection as a click does, so the Network follows.
    select(rows[nextRow - offset]?.id ?? null, fields[nextColumn])
  }
  async function load() {
    controller?.abort()
    if (!view.summary || view.stale) return
    const request = (controller = new AbortController())
    const current = ++generation
    loading = true
    try {
      // The filter matches a row's name, else its identity.
      const named = allFields.includes('name') ? 'name' : identity
      const where: NonNullable<RowsQuery['where']>[number][] = [
        ...(filter && named
          ? [{ field: named, operator: 'contains', value: filter } as const]
          : []),
        ...(equal ? [{ field: equal.field, operator: 'equal', value: equal.value } as const] : []),
      ]
      const query: RowsQuery = {
        kind: 'rows',
        from: type,
        select: fields,
        offset,
        limit: 100,
        count: true,
        ids: true,
        ...(order ? { orderBy: [order] } : {}),
        ...(where.length ? { where } : {}),
      }
      const blocks = await bridge.request('query', $state.snapshot(query), request.signal)
      if (generation !== current) return
      const references = await referenceNames(blocks, (query) =>
        bridge.request('query', query, request.signal),
      )
      if (generation !== current) return
      rows = rowsOf(blocks, references)
      total = blocks[0]?.total ?? rows.length
      // The view's title says how many rows the filters leave.
      persist()
      await tick()
      scrolled()
    } catch (reason) {
      if (generation === current && !request.signal.aborted) bridge.report(reason)
    } finally {
      if (generation === current) loading = false
    }
  }
  $effect(() => {
    generation++
    void view.summary?.version
    void view.stale
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
  function changeType(next: string) {
    type = next
    // The rows go with their type; its own load in a moment.
    rows = []
    offset = 0
    filter = ''
    equal = undefined
    order = undefined
    fields =
      columns[next]?.filter((field) => allFields.includes(field)) ?? allFields.slice(0, COLUMNS)
    persist()
    bridge.save({ type })
    if (scroll) scroll.scrollTop = 0
  }
  /** Order the rows by `field`: as `direction` says, else the other way from now. */
  function sort(field: string, direction?: 'ascending' | 'descending') {
    order = {
      field,
      direction:
        direction ??
        (order?.field === field && order.direction === 'ascending' ? 'descending' : 'ascending'),
    }
    offset = 0
    scroll.scrollTop = 0
  }
  function select(id: string | null, field?: string) {
    if (!id) return
    own = id
    bridge.send({ kind: 'select', element: { id, ...(field ? { field } : {}) } })
  }
  function edit(id: string | null, field: string, value: unknown) {
    if (!id || view.stale || !view.writable || !view.summary?.editable[type]?.includes(field))
      return
    const spec = view.summary?.schema.types[type]?.fields[field]
    editing = {
      id,
      field,
      version: view.summary!.version,
      text:
        spec?.type === 'text'
          ? String(value ?? '')
          : isReference(spec)
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
    if (!edit || !view.summary) return
    editing = undefined
    try {
      const spec = view.summary.schema.types[type]!.fields[edit.field]!
      const value: Value =
        spec.type === 'text' || isReference(spec)
          ? isReference(spec) && edit.text === 'null'
            ? null
            : edit.text
          : JSON.parse(edit.text)
      await bridge.request('transact', {
        version: edit.version,
        mutations: [{ kind: 'set', id: edit.id, field: edit.field, value }],
        label: 'Edit ' + leaf(edit.field),
      })
    } catch (reason) {
      bridge.report(reason)
    }
  }
  /** Scroll the selected row into view once it is drawn; whether it was. */
  function scrolled(): boolean {
    const shown = revealing && scroll?.querySelector('tr.selected')
    if (!shown) return false
    shown.scrollIntoView({ block: 'nearest' })
    revealing = undefined
    return true
  }
  /** Show the selected element's row: switch to its type, and scroll the row into view, now or
   *  once the page holding it loads. */
  async function reveal(id: string) {
    const next = elementType(id)
    revealing = id
    if (next !== type) changeType(next)
    await tick()
    if (scrolled()) return
    // A row the filters leave out shows once they go.
    filter = ''
    equal = undefined
    order = undefined
    try {
      const blocks = await bridge.request('query', {
        kind: 'rows',
        from: next,
        select: [],
        ids: true,
        rows: { kind: 'ids', ids: [id] },
        limit: 1,
      })
      // The page holding the row loads, and `scrolled` brings the row into view once it is drawn.
      const row = rowsOf(blocks)[0]
      if (row && view.selection?.id === id) offset = Math.max(0, row.row - 10)
    } catch (reason) {
      bridge.report(reason)
    }
  }
  onMount(() => {
    const stop = bridge.on((message) => {
      if (message.kind === 'state') {
        const first = !view.summary
        const before = view.selection?.id
        view = merged(view, message.state)
        appearance(view.settings)
        if (first && view.summary) {
          // Open on the selection's type, else where the panel was left.
          const saved = view.table
          const wanted = view.selection ? elementType(view.selection.id) : saved?.type
          columns = saved?.columns ?? {}
          const counts = view.summary.counts
          changeType(
            wanted && counts[wanted]
              ? wanted
              : counts[type]
                ? type
                : (Object.keys(counts).find((each) => counts[each]! > 0) ?? 'Bus'),
          )
          if (type === saved?.type) {
            filter = saved.filter ?? ''
            equal = saved.equal
          }
          persist()
        }
        // A selection made in another view is brought into sight; one made here already is.
        const selected = view.selection?.id
        if (selected && selected !== before && selected !== own && view.summary && !view.stale)
          void reveal(selected)
        if (selected !== own) own = undefined
      } else if (message.kind === 'action') {
        const value = message.value as Record<string, unknown> | undefined
        if (message.command === 'columns' && Array.isArray(message.value))
          show(message.value.filter((field): field is string => typeof field === 'string'))
        else if (message.command === 'resetColumns') {
          delete columns[type]
          fields = allFields.slice(0, COLUMNS)
        } else if (message.command === 'hideColumn')
          show(fields.filter((field) => field !== message.value))
        else if (message.command === 'sort') {
          if (typeof value?.field === 'string')
            sort(value.field, value.direction === 'descending' ? 'descending' : 'ascending')
          else {
            order = undefined
            offset = 0
          }
        } else if (message.command === 'type' && typeof message.value === 'string') {
          if (message.value !== type) changeType(message.value)
        } else if (message.command === 'filter' || message.command === 'filterText') {
          if (message.command === 'filter')
            equal =
              value && typeof value.field === 'string' ? (value as TableState['equal']) : undefined
          else filter = typeof message.value === 'string' ? message.value : ''
          offset = 0
          if (scroll) scroll.scrollTop = 0
        } else if (message.command === 'clearFilters') {
          filter = ''
          equal = undefined
          offset = 0
        }
        persist()
      }
    })
    bridge.send({ kind: 'ready' })
    return () => {
      stop()
      controller?.abort()
    }
  })
</script>

<main class="case">
  {#if !view.summary && view.error}
    <p class="c-note c-note--warn" role="status">
      The case shows once the problems listed in Problems are fixed.
    </p>
  {:else if view.stale && view.summary}
    <p class="c-note c-note--warn" role="status">
      Showing the last valid revision until the source is fixed. Editing waits for it.
    </p>
  {/if}
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
            {@const unit = unitOf(definitions[field], field)}
            <th
              scope="col"
              aria-sort={order?.field === field ? order.direction : 'none'}
              data-vscode-context={context(null, field)}
            >
              <button onclick={() => sort(field)} title={field}>
                {leaf(field)}{#if unit}<span class="case__unit">
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
        {#if offset > 0}<tr aria-hidden="true">
            <td
              colspan={fields.length + 2}
              style:height={offset * height + 'px'}
              class="spacer"
            ></td>
          </tr>{/if}
        {#each rows as row, rowIndex (row.id)}
          <tr
            class:selected={view.selection?.id === row.id}
            aria-rowindex={offset + rowIndex + 2}
            data-vscode-context={context(row.id)}
          >
            <th scope="row">
              <button onclick={() => select(row.id)} title={row.id ?? ''}>
                {row.id ? native(row.id) : ''}
              </button>
            </th>
            {#each fields as field, columnIndex (field)}
              <td
                data-vscode-context={context(row.id, field)}
                class:numeric={typeof row.values[field] === 'number'}
              >
                {#if editing?.id === row.id && editing.field === field}
                  <input
                    use:focus
                    aria-label={'Edit ' + leaf(field)}
                    bind:value={editing.text}
                    onkeydown={(event) => {
                      if (event.key === 'Enter') void commit()
                      if (event.key === 'Escape') editing = undefined
                    }}
                    onblur={() => void commit()}
                    placeholder={isReference(definitions[field]) ? 'Type/ID' : ''}
                  />
                {:else}
                  <button
                    class="cell"
                    data-row={offset + rowIndex}
                    data-column={columnIndex}
                    tabindex={(view.selection?.id === row.id && view.selection?.field === field) ||
                    (!view.selection && rowIndex === 0 && columnIndex === 0)
                      ? 0
                      : -1}
                    onclick={() => select(row.id, field)}
                    ondblclick={() => edit(row.id, field, row.values[field])}
                    onkeydown={(event) => {
                      if (event.key === 'Enter' || event.key === 'F2') {
                        event.preventDefault()
                        edit(row.id, field, row.values[field])
                      } else void move(event, offset + rowIndex, columnIndex)
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
        {#if total > offset + rows.length}<tr aria-hidden="true">
            <td
              colspan={fields.length + 2}
              style:height={(total - offset - rows.length) * height + 'px'}
              class="spacer"
            ></td>
          </tr>{/if}
      </tbody>
    </table>
    {#if !view.summary || (!total && !loading)}
      <div class="c-empty">
        <p class="c-empty__text">{view.summary ? 'No matching elements.' : 'Loading case…'}</p>
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
     Diagram halo the selection in. */
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

<script lang="ts">
  import type { FieldDefinition, RowsQuery, Value } from '@latkit/model'
  import { onMount, tick } from 'svelte'

  import { display, referenceNames, rowsOf } from '../../shared/cells.js'
  import { menuContext } from '../../shared/contexts.js'
  import type { ViewState } from '../../shared/messages.js'
  import { elementType, isReference } from '../../shared/schema.js'
  import { bridge, merged } from '../bridge.js'
  import { appearance } from '../theme.js'
  let view = $state<ViewState>({})
  let type = $state(bridge.state({ type: 'Bus' }).type)
  let fields = $state<string[]>([])
  let filter = $state('')
  let order = $state<{ field: string; direction: 'ascending' | 'descending' } | undefined>()
  let offset = $state(0)
  let total = $state(0)
  let error = $state('')
  let loading = $state(false)
  let rows = $state<ReturnType<typeof rowsOf>>([])
  let editing = $state<{ id: string; field: string; text: string; version: number } | undefined>()
  let scroll: HTMLDivElement
  let generation = 0
  let controller: AbortController | undefined
  const definitions = $derived<Readonly<Record<string, FieldDefinition>>>(
    view.summary?.schema.types[type]?.fields ?? {},
  )
  /** The type's static fields; sampled ones belong to the Monitor. */
  const allFields = $derived(
    Object.keys(definitions).filter((field) => !definitions[field]?.sampled),
  )
  const types = $derived(
    Object.entries(view.summary?.counts ?? {}).filter(([, count]) => count > 0),
  )
  /** How many columns a type shows until the user picks them. */
  const COLUMNS = 12
  /** Row height in px for virtual scrolling: the --spacing-row-h token. */
  const height = 28
  const context = (id: string | null, field?: string) =>
    view.summary
      ? JSON.stringify(
          menuContext(
            view.summary,
            {
              uri: view.summary.uri,
              version: view.summary.version,
              origin: 'table',
              type,
              field,
              ...(id ? { element: { id, ...(field ? { field } : {}) } } : {}),
            },
            view.bindings,
          ),
        )
      : '{}'
  const persist = () =>
    bridge.send({ kind: 'tableState', table: { type, fields: $state.snapshot(fields), filter } })
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
  }
  async function load() {
    controller?.abort()
    if (!view.summary || view.stale) return
    const request = (controller = new AbortController())
    const current = ++generation
    loading = true
    error = ''
    try {
      const query: RowsQuery = {
        kind: 'rows',
        from: type,
        select: fields,
        offset,
        limit: 100,
        count: true,
        ids: true,
        ...(order ? { orderBy: [order] } : {}),
        ...(filter
          ? {
              where: [
                {
                  field: allFields.includes('name') ? 'name' : allFields[0]!,
                  operator: 'contains',
                  value: filter,
                },
              ],
            }
          : {}),
      }
      const blocks = await bridge.request('query', $state.snapshot(query), request.signal)
      if (generation !== current) return
      const references = await referenceNames(blocks, (query) =>
        bridge.request('query', query, request.signal),
      )
      if (generation !== current) return
      rows = rowsOf(blocks, references)
      total = blocks[0]?.total ?? rows.length
    } catch (reason) {
      if (generation === current && !request.signal.aborted) error = String(reason)
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
    offset = 0
    filter = ''
    order = undefined
    fields = allFields.slice(0, COLUMNS)
    persist()
    bridge.save({ type })
    if (scroll) scroll.scrollTop = 0
  }
  function sort(field: string) {
    order = {
      field,
      direction:
        order?.field === field && order.direction === 'ascending' ? 'descending' : 'ascending',
    }
    offset = 0
    scroll.scrollTop = 0
  }
  function select(id: string | null, field?: string) {
    if (id) bridge.send({ kind: 'select', element: { id, ...(field ? { field } : {}) } })
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
        label: 'Edit ' + edit.field,
      })
    } catch (reason) {
      error = String(reason)
    }
  }
  async function reveal(id: string) {
    const next = elementType(id)
    if (next !== type) changeType(next)
    else {
      filter = ''
      order = undefined
    }
    try {
      const blocks = await bridge.request('query', {
        kind: 'rows',
        from: next,
        select: [],
        ids: true,
        rows: { kind: 'ids', ids: [id] },
        limit: 1,
      })
      const row = rowsOf(blocks)[0]
      if (row && view.selection?.id === id) {
        offset = Math.max(0, row.row - 10)
        if (scroll) scroll.scrollTop = row.row * height
      }
    } catch (reason) {
      error = String(reason)
    }
  }
  onMount(() => {
    const stop = bridge.on((message) => {
      if (message.kind === 'state') {
        const first = !view.summary
        const before = view.selection?.id
        view = merged(view, message.state)
        appearance(view.settings)
        if (
          view.selection?.id &&
          view.selection.id !== before &&
          view.summary &&
          !view.stale &&
          !rows.some((row) => row.id === view.selection!.id)
        )
          void reveal(view.selection.id)
        if (first && view.summary) {
          const saved = view.table
          changeType(
            saved?.type && view.summary.counts[saved.type]
              ? saved.type
              : view.summary.counts[type]
                ? type
                : (types[0]?.[0] ?? 'Bus'),
          )
          if (saved?.fields) fields = saved.fields.filter((field) => allFields.includes(field))
          filter = saved?.filter ?? ''
          persist()
        }
      } else if (message.kind === 'action') {
        if (message.command === 'columns' && Array.isArray(message.value))
          fields = message.value.filter(
            (field): field is string => typeof field === 'string' && allFields.includes(field),
          )
        if (message.command === 'resetColumns') fields = allFields.slice(0, COLUMNS)
        if (message.command === 'clearTableFilter') filter = ''
        if (message.command === 'filterTable') filter = String(message.value ?? '')
        if (message.command === 'selectClass' && view.summary?.schema.types[String(message.value)])
          changeType(String(message.value))
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

<main class="table">
  {#if view.error}
    <p class="c-note c-note--error" role="alert">{view.error}</p>
  {:else if view.stale && view.summary}
    <p class="c-note c-note--warn" role="status">
      Source is updating or invalid. Showing the last valid revision; editing is paused.
    </p>
  {/if}
  {#if error}<p class="c-note c-note--error" role="alert">{error}</p>{/if}
  <div
    class="table-scroll"
    bind:this={scroll}
    onscroll={() => {
      const next = Math.max(0, Math.floor(scroll.scrollTop / height) - 10)
      if (Math.abs(next - offset) >= 10) offset = next
    }}
  >
    <table aria-label={type + ' fields'} aria-rowcount={total + 1}>
      <thead>
        <tr>
          <th scope="col">Element</th>
          {#each fields as field (field)}<th
              scope="col"
              aria-sort={order?.field === field ? order.direction : 'none'}
            >
              <button onclick={() => sort(field)}>
                {field}{definitions[field]?.unit
                  ? ' [' + definitions[field]!.unit + ']'
                  : ''}{order?.field === field
                  ? order.direction === 'ascending'
                    ? ' (ascending)'
                    : ' (descending)'
                  : ''}
              </button>
            </th>{/each}
        </tr>
      </thead>
      <tbody>
        {#if offset > 0}<tr aria-hidden="true">
            <td
              colspan={fields.length + 1}
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
              <button onclick={() => select(row.id)} title={row.id ?? ''}>{row.id}</button>
            </th>
            {#each fields as field, columnIndex (field)}
              <td
                data-vscode-context={context(row.id, field)}
                class:numeric={typeof row.values[field] === 'number'}
              >
                {#if editing?.id === row.id && editing.field === field}
                  <input
                    use:focus
                    aria-label={'Edit ' + field}
                    bind:value={editing.text}
                    onkeydown={(event) => {
                      if (event.key === 'Enter') void commit()
                      if (event.key === 'Escape') editing = undefined
                    }}
                    onblur={() => void commit()}
                    placeholder={typeof definitions[field]?.type === 'object'
                      ? 'Type/native-ID'
                      : ''}
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
                    title={'Double-click or press F2 to edit ' + field}
                  >
                    {display(row.values[field])}
                  </button>
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
        {#if total > offset + rows.length}<tr aria-hidden="true">
            <td
              colspan={fields.length + 1}
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
  <div class="table__status" aria-live="polite">
    {total.toLocaleString()} elements · revision {view.summary?.version ?? '…'}{loading
      ? ' · Loading rows…'
      : ''}
  </div>
</main>

<style>
  .table {
    display: flex;
    flex-direction: column;
    block-size: 100%;
  }
  .table-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  table {
    border-collapse: separate;
    border-spacing: 0;
    width: 100%;
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
  tr.selected,
  tr.selected th {
    background: var(--color-selected);
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
  .table__status {
    flex: none;
    padding: var(--spacing-2xs) var(--spacing-md);
    border-top: 1px solid var(--color-border);
    color: var(--color-text-2);
    font-size: var(--text-xs);
  }
</style>

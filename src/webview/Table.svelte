<script lang="ts">
  import type { RowsBlock, RowsQuery, Value } from '@latkit/model'
  import { onMount, tick } from 'svelte'

  import { display, referenceNames, rowsOf } from '../cells.js'
  import { menuContext } from '../contexts.js'
  import type { ViewState } from '../messages.js'
  import { bridge } from './bridge.js'
  import { accessibility } from './style.js'
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
  const allFields = $derived(
    Object.keys(view.summary?.schema.types[type]?.fields ?? {}).filter(
      (field) => !view.summary?.schema.types[type]?.fields[field]?.sampled,
    ),
  )
  const types = $derived(
    Object.entries(view.summary?.counts ?? {}).filter(([, count]) => count > 0),
  )
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
      const blocks = await bridge.request<RowsBlock[]>(
        'query',
        $state.snapshot(query),
        request.signal,
      )
      if (generation !== current) return
      const references = await referenceNames(blocks, (query) =>
        bridge.request<RowsBlock[]>('query', query, request.signal),
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
    fields = Object.keys(view.summary?.schema.types[type]?.fields ?? {})
      .filter((field) => !view.summary?.schema.types[type]?.fields[field]?.sampled)
      .slice(0, 12)
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
          : typeof spec?.type === 'object' && spec.type.kind === 'reference'
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
        spec.type === 'text' || (typeof spec.type === 'object' && spec.type.kind === 'reference')
          ? typeof spec.type === 'object' && edit.text === 'null'
            ? null
            : edit.text
          : JSON.parse(edit.text)
      await bridge.request('edit', { id: edit.id, field: edit.field, value, version: edit.version })
    } catch (reason) {
      error = String(reason)
    }
  }
  async function reveal(id: string) {
    const next = id.split('/')[0]!
    if (next !== type) changeType(next)
    else {
      filter = ''
      order = undefined
    }
    try {
      const blocks = await bridge.request<RowsBlock[]>('query', {
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
        view = { ...view, ...message.state }
        accessibility(view)
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
        if (message.command === 'resetColumns') fields = allFields.slice(0, 12)
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

<main class="shell">
  {#if view.stale}<div class="warning" role="status">
      Source is updating or invalid. Showing the last valid revision; editing is paused.
    </div>{/if}
  {#if error}<div class="error" role="alert">{error}</div>{/if}
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
                {field}{view.summary?.schema.types[type]?.fields[field]?.unit
                  ? ' [' + view.summary.schema.types[type]!.fields[field]!.unit + ']'
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
                    placeholder={typeof view.summary?.schema.types[type]?.fields[field]?.type ===
                    'object'
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
    {#if !view.summary}<div class="empty">Loading case…</div>{:else if !total && !loading}<div
        class="empty"
      >
        No matching elements.
      </div>{/if}
  </div>
  <div class="status" aria-live="polite">
    {total.toLocaleString()} elements · revision {view.summary?.version ?? '…'}{loading
      ? ' · Loading rows…'
      : ''}
  </div>
</main>

<style>
  .table-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  table {
    border-collapse: separate;
    border-spacing: 0;
    width: 100%;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  thead {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--vscode-editor-background);
  }
  th,
  td {
    height: 28px;
    padding: 0 6px;
    border-bottom: 1px solid var(--vscode-panel-border);
    text-align: left;
    font-weight: normal;
  }
  th button,
  .cell {
    display: block;
    background: transparent;
    color: inherit;
    border: 0;
    width: 100%;
    text-align: left;
    padding: 4px;
    min-height: 28px;
    max-width: 28rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cell:hover {
    background: var(--vscode-list-hoverBackground);
  }
  tr.selected {
    background: var(--vscode-list-inactiveSelectionBackground);
  }
  td input {
    width: 100%;
    min-width: 7rem;
  }
  .spacer {
    padding: 0;
    border: 0;
  }
  tbody th {
    position: sticky;
    left: 0;
    background: var(--vscode-editor-background);
    border-right: 1px solid var(--vscode-panel-border);
  }
  .numeric .cell {
    text-align: right;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  tr.selected th {
    background: var(--vscode-list-inactiveSelectionBackground);
  }
  .cell:focus-visible {
    outline-offset: -2px;
    background: var(--vscode-list-focusBackground);
  }
</style>

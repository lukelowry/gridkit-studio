<!-- The Case panel: one type's elements as rows, its fields as columns under the record key they
  sit in. A column's menu maps it onto the network. -->
<script lang="ts">
  import type { FieldDefinition, RowsQuery, Value } from '@latkit/model'
  import { onMount, tick } from 'svelte'

  import { channelsOf, shortNames } from '../../shared/bindings.js'
  import { bands, display, leaf, native, referenceNames, rowsOf } from '../../shared/cells.js'
  import { menuContext } from '../../shared/contexts.js'
  import type { ViewState } from '../../shared/messages.js'
  import { elementType, isReference, typeName } from '../../shared/schema.js'
  import { bridge, merged } from '../bridge.js'
  import { appearance } from '../theme.js'
  import Select from '../ui/Select.svelte'

  /** The heading each record key's columns sit under. */
  const GROUPS: Readonly<Record<string, string>> = {
    params: 'Parameters',
    init: 'Initial',
    ports: 'Ports',
    extension: 'Extension',
  }
  /** How many columns a type shows until the user picks them. */
  const COLUMNS = 12
  /** Row height in px for virtual scrolling: the --spacing-row-h token. */
  const height = 28

  let view = $state<ViewState>({})
  let type = $state(bridge.state({ type: 'Bus' }).type)
  let fields = $state<string[]>([])
  let filter = $state('')
  let order = $state<{ field: string; direction: 'ascending' | 'descending' } | undefined>()
  let offset = $state(0)
  let total = $state(0)
  let loading = $state(false)
  let rows = $state<ReturnType<typeof rowsOf>>([])
  let editing = $state<{ id: string; field: string; text: string; version: number } | undefined>()
  let scroll: HTMLDivElement
  let generation = 0
  let controller: AbortController | undefined
  const definitions = $derived<Readonly<Record<string, FieldDefinition>>>(
    view.summary?.schema.types[type]?.fields ?? {},
  )
  /** The field each row is known by, shown as the row's own header. */
  const identity = $derived(view.summary?.identities[type])
  /** The type's static fields besides its identity; sampled ones belong to the Monitor. */
  const allFields = $derived(
    Object.keys(definitions).filter((field) => !definitions[field]?.sampled && field !== identity),
  )
  const types = $derived(
    Object.entries(view.summary?.counts ?? {})
      .filter(([, count]) => count > 0)
      .map(([value, count]) => ({
        value,
        label: `${typeName(view.summary!.schema, value)} · ${count.toLocaleString()}`,
        group: view.summary!.schema.types[value]?.description ?? '',
      })),
  )
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
      ? JSON.stringify(
          menuContext(
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
    try {
      // The filter matches a row's name, else its identity.
      const named = allFields.includes('name') ? 'name' : identity
      const query: RowsQuery = {
        kind: 'rows',
        from: type,
        select: fields,
        offset,
        limit: 100,
        count: true,
        ids: true,
        ...(order ? { orderBy: [order] } : {}),
        ...(filter && named
          ? { where: [{ field: named, operator: 'contains', value: filter }] }
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
        label: 'Edit ' + leaf(edit.field),
      })
    } catch (reason) {
      bridge.report(reason)
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
                : (types[0]?.value ?? 'Bus'),
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
  {#if view.summary}
    <div class="case__bar">
      <div class="case__type">
        <Select
          label="Type"
          hideLabel
          compact
          options={types}
          data-testid="case-type"
          bind:value={() => type, (next) => next && next !== type && changeType(next)}
        />
      </div>
      <input
        class="c-input case__filter"
        type="search"
        placeholder={'Filter ' + typeName(view.summary.schema, type)}
        aria-label="Filter elements"
        data-testid="case-filter"
        bind:value={
          () => filter,
          (next) => {
            filter = next
            offset = 0
            persist()
          }
        }
      />
    </div>
  {/if}
  <div
    class="case__scroll"
    bind:this={scroll}
    onscroll={() => {
      const next = Math.max(0, Math.floor(scroll.scrollTop / height) - 10)
      if (Math.abs(next - offset) >= 10) offset = next
    }}
  >
    <table aria-label={type + ' fields'} aria-rowcount={total + 2}>
      <thead>
        <tr class="case__bands">
          <th rowspan="2" scope="col" class="case__identity">{identity ?? ''}</th>
          {#each bands(fields) as { group, span }, i (i)}
            <th colspan={span} scope="colgroup">{GROUPS[group] ?? group}</th>
          {/each}
        </tr>
        <tr>
          {#each fields as field (field)}
            <th
              scope="col"
              aria-sort={order?.field === field ? order.direction : 'none'}
              data-vscode-context={context(null, field)}
            >
              <button onclick={() => sort(field)} title={field}>
                {leaf(field)}{#if definitions[field]?.unit}<span class="case__unit">
                    {definitions[field]!.unit}
                  </span>{/if}{#if mapped.has(field)}<span class="case__mapped">
                    {mapped.get(field)}
                  </span>{/if}
              </button>
            </th>
          {/each}
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
            aria-rowindex={offset + rowIndex + 3}
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
                    title={'Double-click or press F2 to edit ' + leaf(field)}
                  >
                    {display(row.values[field], { native: true })}
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
  <div class="case__status" aria-live="polite">
    {total.toLocaleString()} elements · revision {view.summary?.version ?? '…'}{loading
      ? ' · Loading rows…'
      : ''}
  </div>
</main>

<style>
  .case {
    display: flex;
    flex-direction: column;
    block-size: 100%;
  }
  .case__bar {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--spacing-sm);
    padding: var(--spacing-2xs) var(--spacing-sm);
    border-bottom: 1px solid var(--color-border);
  }
  .case__type {
    flex: 0 1 16rem;
    min-inline-size: 6rem;
  }
  .case__filter {
    flex: 0 1 14rem;
    min-inline-size: 6rem;
  }
  .case__scroll {
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
  .case__bands th:not(.case__identity) {
    height: auto;
    padding-block: var(--spacing-2xs) 0;
    border-bottom: 0;
    font-size: var(--text-xs);
    font-weight: normal;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .case__bands th:not(:empty):not(.case__identity) {
    border-inline-start: 1px solid var(--color-border);
  }
  .case__identity {
    vertical-align: bottom;
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
  .case__status {
    flex: none;
    padding: var(--spacing-2xs) var(--spacing-md);
    border-top: 1px solid var(--color-border);
    color: var(--color-text-2);
    font-size: var(--text-xs);
  }
</style>

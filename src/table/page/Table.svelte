<script lang="ts">
  import type { GridSort } from '@latkit/model'
  import { onMount } from 'svelte'

  import { NO_CAPABILITIES } from '../../menus.js'
  import { port, vscode } from '../../webview/client.js'
  import { defaults, type TableFocus, type TableState, type TableTime } from '../messages.js'
  import type { Table } from '../query.js'
  import { connectTable } from '../transport.js'
  import VirtualTable from './VirtualTable.svelte'

  let data = $state.raw<TableState>({
    type: 'table',
    name: 'Case',
    status: 'Loading case...',
    classId: '',
    classLabel: '',
    columns: [],
    selection: null,
    capabilities: NO_CAPABILITIES,
    settings: defaults(),
    settingsVersion: 0,
  })
  let source = $state.raw<Table | null>(null)
  let sort = $state.raw<GridSort | null>(null)
  let scrollTop = $state(0)
  let widths = $state.raw<Record<string, number>>({})
  let connection = $state('')
  let total = $state<number | null>(null)
  let appliedVersion = -1
  let time = $state<number | undefined>()
  let frame = $state<number | undefined>()
  let frameCount = $state<number | undefined>()
  let tick = $state(0)
  let focusReady = $state(0)
  let shownTime = $state<number | undefined>()
  const columns = $derived(
    data.columns.filter(
      (column) =>
        column.identity ||
        (data.settings.visible
          ? data.settings.visible.includes(column.id!)
          : column.id !== 'top.class'),
    ),
  )

  onMount(() => {
    const focus = () => vscode.postMessage({ type: 'focus' })
    const shortcut = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'f' &&
        data.target
      ) {
        event.preventDefault()
        event.stopPropagation()
        vscode.postMessage({ type: 'filter', target: data.target })
      }
    }
    document.addEventListener('keydown', shortcut, true)
    window.addEventListener('focus', focus)
    document.addEventListener('focusin', focus)
    const off = port.subscribe((message) => {
      const next = message as TableState | TableTime | TableFocus
      if (next?.type === 'focus-table') {
        if (next.grid === data.grid && next.request === data.focusRequest) focusReady = next.request
        return
      }
      if (next?.type !== 'table' && next?.type !== 'time') return
      if (next.type === 'time' && next.grid !== data.grid) return
      time = next.time
      frame = next.frame
      frameCount = next.frameCount
      tick = next.tick ?? 0
      if (next.type === 'time') return
      if (next.settingsVersion !== appliedVersion) {
        appliedVersion = next.settingsVersion
        sort = next.settings.sort
        scrollTop = next.settings.scrollTop
        widths = next.settings.widths
      }
      if (next.grid !== data.grid || next.settings.query !== data.settings.query) total = null
      data = next
      document.body.dataset.grid = next.grid ?? ''
      document.body.dataset.version = String(next.target?.version ?? '')
      document.body.dataset.case = next.target?.uri ?? ''
      document.body.dataset.class = next.classId
      document.body.dataset.query = next.settings.query
      if (connection !== (next.grid ?? '')) {
        source?.close()
        source = null
        connection = next.grid ?? ''
        if (next.grid) {
          const name = next.grid
          source = connectTable(port, name, next.rowCount ?? 0)
        }
      }
    })
    vscode.postMessage({ type: 'ready' })
    return () => {
      document.removeEventListener('keydown', shortcut, true)
      off()
      source?.close()
      window.removeEventListener('focus', focus)
      document.removeEventListener('focusin', focus)
    }
  })
  $effect(() => {
    if (!data.target || !connection) return
    const message = {
      type: 'view',
      target: data.target,
      grid: connection,
      settingsVersion: data.settingsVersion,
      settings: { ...data.settings, sort, scrollTop, widths },
    }
    // Persist before a subsequent case switch; disk writes are debounced by the host.
    vscode.postMessage(message)
  })
</script>

<section aria-label="Case data" class="case-data">
  {#if source && data.target}
    <p class="table-context">
      <span class="case-name" title={data.name}>{data.name}</span>
      {#if shownTime !== undefined}<span>t = {shownTime.toPrecision(6)} s</span>{/if}
      <span class="class-summary">
        {data.classLabel} · {total === null
          ? data.settings.query
            ? 'Filtering...'
            : `${source.rowCount.toLocaleString()} rows`
          : data.settings.query
            ? `${total.toLocaleString()} of ${source.rowCount.toLocaleString()} rows`
            : `${total.toLocaleString()} rows`}
      </span>
      {#if data.settings.query}<span
          class="filter-summary"
          title={`Filter: ${data.settings.query}`}
        >
          Filter: {data.settings.query}
        </span>{/if}
    </p>
  {/if}
  <VirtualTable
    {tick}
    {time}
    {frame}
    {frameCount}
    focusRequest={data.focusRequest ?? 0}
    {focusReady}
    {source}
    query={data.settings.query}
    bind:sort
    bind:scrollTop
    bind:widths
    target={data.target}
    classId={data.classId}
    {columns}
    capabilities={data.capabilities}
    selection={data.selection}
    onfocusready={(request) =>
      vscode.postMessage({ type: 'focusReady', target: data.target, grid: data.grid, request })}
    onselect={(selection) => vscode.postMessage({ type: 'select', target: data.target, selection })}
    onstats={(value, time) => {
      shownTime = time
      total = value
    }}
  />
  {#if !source}<p class="notice" role="status">{data.status || 'Loading rows...'}</p>{/if}
</section>

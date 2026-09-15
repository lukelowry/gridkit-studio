<script lang="ts">
  import type { Grid, GridSort } from '@latkit/model'
  import { connectGrid, type GridHeader } from '@latkit/remote'
  import { onMount } from 'svelte'

  import { NO_CAPABILITIES } from '../../menus.js'
  import { port, vscode } from '../../webview/client.js'
  import { defaults, type TableState } from '../messages.js'
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
  let source = $state.raw<(Grid & GridHeader) | null>(null)
  let sort = $state.raw<GridSort | null>(null)
  let scrollTop = $state(0)
  let widths = $state.raw<Record<string, number>>({})
  let connection = $state('')
  let total = $state<number | null>(null)
  let appliedVersion = -1
  let disconnect: (() => void) | undefined
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
      const next = message as TableState
      if (next?.type !== 'table') return
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
        disconnect?.()
        source = null
        connection = next.grid ?? ''
        if (next.grid) {
          const name = next.grid
          disconnect = connectGrid(port, name, (value) => {
            if (connection === name) source = value
          })
        }
      }
    })
    vscode.postMessage({ type: 'ready' })
    return () => {
      document.removeEventListener('keydown', shortcut, true)
      off()
      disconnect?.()
      window.removeEventListener('focus', focus)
      document.removeEventListener('focusin', focus)
    }
  })
  $effect(() => {
    if (data.target && connection)
      vscode.postMessage({
        type: 'view',
        target: data.target,
        grid: connection,
        settingsVersion: data.settingsVersion,
        settings: { ...data.settings, sort, scrollTop, widths },
      })
  })
</script>

<section aria-label="Case data" class="case-data">
  {#if source && data.target}
    <p class="table-context">
      <span class="case-name" title={data.name}>{data.name}</span>
      {#if data.time !== undefined}<span>t = {data.time.toPrecision(6)} s</span>{/if}
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
    {#key connection}
      <VirtualTable
        tick={data.tick ?? 0}
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
        onselect={(selection) =>
          vscode.postMessage({ type: 'select', target: data.target, selection })}
        onstats={(value) => {
          total = value
        }}
      />
    {/key}
  {:else}<p class="notice" role="status">{data.status || 'Loading rows...'}</p>{/if}
</section>

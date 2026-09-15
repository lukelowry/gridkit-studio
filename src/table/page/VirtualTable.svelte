<script lang="ts">
  import type { Grid, GridSort, GridWindow } from '@latkit/model'
  import type { GridHeader } from '@latkit/remote'
  import { onDestroy, untrack } from 'svelte'

  import { describe } from '../../errors.js'
  import { type Capabilities, menuContext } from '../../menus.js'
  import type { CaseTarget, Selection } from '../../targets.js'
  import { tableFieldId } from '../columns.js'
  import type { TableState } from '../messages.js'
  let {
    source,
    tick = 0,
    query,
    sort = $bindable(null),
    scrollTop = $bindable(0),
    widths = $bindable({}),
    target,
    classId,
    columns,
    capabilities,
    selection,
    onselect,
    onstats,
  }: {
    tick?: number
    source: Grid & GridHeader
    query: string
    sort: GridSort | null
    scrollTop: number
    target: CaseTarget
    classId: string
    columns: TableState['columns']
    widths: Record<string, number>
    capabilities: Capabilities
    selection: Selection | null
    onselect: (selection: Selection) => void
    onstats: (total: number) => void
  } = $props()
  const ROW = 28
  const HEADER = 32
  const OVERSCAN = 6
  let viewport = $state<HTMLDivElement>()
  let menuElement = $state<HTMLDivElement>()
  let height = $state(300)
  let windowData = $state.raw<GridWindow>({ rows: [], total: untrack(() => source.rowCount) })
  let loading = $state(true)
  let error = $state('')
  let active = $state(0)
  let renderedFirst = $state(0)
  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN))
  const count = $derived(Math.min(4096, Math.ceil(height / ROW) + 2 * OVERSCAN))
  const selected = $derived(selection?.element.classId === classId ? selection.element.index : null)
  const columnWidth = (column: TableState['columns'][number]) =>
    widths[column.id ?? '@identity'] ?? column.width
  const width = $derived(columns.reduce((total, column) => total + columnWidth(column), 0))
  const activeId = $derived(
    windowData.rows.some((_, i) => renderedFirst + i === active) ? `row-${active}` : undefined,
  )

  $effect(() => {
    const el = viewport
    if (!el) return
    const observer = new ResizeObserver(() => {
      height = el.clientHeight
    })
    observer.observe(el)
    el.scrollTop = untrack(() => scrollTop)
    return () => observer.disconnect()
  })
  $effect(() => {
    const controller = new AbortController()
    void tick
    const offset = first
    loading = true
    error = ''
    source.window(query, sort, offset, count, controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return
        windowData = value
        renderedFirst = offset
        loading = false
        onstats(value.total)
      },
      (reason) => {
        if (!controller.signal.aborted) {
          error = describe(reason)
          loading = false
        }
      },
    )
    return () => controller.abort()
  })
  $effect(() => {
    if (viewport && Math.abs(viewport.scrollTop - scrollTop) > 1) viewport.scrollTop = scrollTop
  })
  $effect(() => {
    const id = selection?.field ? tableFieldId(selection.field) : undefined
    const el = viewport
    if (!id || !el || selected === null) return
    const at = columns.findIndex((column) => column.id === id)
    if (at < 1) return
    const left = columns.slice(0, at).reduce((sum, column) => sum + columnWidth(column), 0)
    const right = left + columnWidth(columns[at])
    if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth
    else if (left < el.scrollLeft + columnWidth(columns[0]))
      el.scrollLeft = Math.max(0, left - columnWidth(columns[0]))
  })
  let keyboardRead: AbortController | undefined
  onDestroy(() => keyboardRead?.abort())
  let previousFilter: string | undefined
  $effect(() => {
    const key = JSON.stringify([query, sort])
    if (previousFilter !== undefined && key !== previousFilter) {
      keyboardRead?.abort()
      active = 0
      scrollTop = 0
      if (viewport) viewport.scrollTop = 0
    }
    previousFilter = key
  })
  function move(position: number) {
    active = Math.max(0, Math.min(position, windowData.total - 1))
    const el = viewport
    if (!el) return
    if (active * ROW < el.scrollTop) el.scrollTop = active * ROW
    else if ((active + 1) * ROW > el.scrollTop + el.clientHeight - HEADER)
      el.scrollTop = (active + 1) * ROW - el.clientHeight + HEADER
    scrollTop = el.scrollTop
  }
  $effect(() => {
    const controller = new AbortController()
    if (selected !== null) {
      source.locate(selected, query, sort, controller.signal).then(
        (position) => {
          if (!controller.signal.aborted && position !== null) move(position)
        },
        () => undefined,
      )
    }
    return () => controller.abort()
  })
  const context = (index?: number, column?: TableState['columns'][number]) =>
    JSON.stringify(
      menuContext(
        {
          ...target,
          ...(index !== undefined && { element: { classId, index } }),
          ...(column?.id && { field: column.field }),
        },
        {
          ...capabilities,
          bind: column ? column.bindable : index !== undefined && capabilities.bind,
          unbind: column ? column.bound : index !== undefined && capabilities.unbind,
          plot: column ? column.field?.source === 'signal' : capabilities.plot,
        },
        'table',
      ),
    )
  function resize(column: TableState['columns'][number], value: number) {
    widths = { ...widths, [column.id ?? '@identity']: Math.max(70, Math.min(800, value)) }
  }
  function startResize(event: PointerEvent, column: TableState['columns'][number]) {
    event.preventDefault()
    event.stopPropagation()
    const el = event.currentTarget as HTMLElement
    const left = event.clientX
    const before = columnWidth(column)
    el.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) => resize(column, before + next.clientX - left)
    const finish = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('lostpointercapture', finish)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('lostpointercapture', finish)
  }
  function cycle(column: string | null) {
    sort =
      sort?.column === column
        ? sort.dir === 'asc'
          ? { column, dir: 'desc' }
          : null
        : { column, dir: 'asc' }
  }
  function select(index: number, position: number, column?: TableState['columns'][number]) {
    active = position
    viewport?.focus()
    onselect({ element: { classId, index }, ...(column?.id && { field: column.field }) })
  }
  async function keyboard(event: KeyboardEvent) {
    if (event.target !== viewport) return
    const positions: Record<string, number> = {
      ArrowDown: active + 1,
      ArrowUp: active - 1,
      Home: 0,
      End: windowData.total - 1,
      PageDown: active + Math.max(1, Math.floor((height - HEADER) / ROW)),
      PageUp: active - Math.max(1, Math.floor((height - HEADER) / ROW)),
    }
    if (event.key in positions) {
      event.preventDefault()
      move(positions[event.key])
      return
    }
    const menu = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')
    if (!menu && event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    keyboardRead?.abort()
    keyboardRead = new AbortController()
    const signal = keyboardRead.signal
    const asked = source
    const filter = query
    const order = sort
    const position = active
    try {
      const result = await asked.window(filter, order, position, 1, signal)
      if (
        signal.aborted ||
        asked !== source ||
        filter !== query ||
        order !== sort ||
        position !== active
      )
        return
      const row = result.rows[0]
      if (!row) return
      if (!menu) {
        onselect({ element: { classId, index: row.index } })
        return
      }
      if (!viewport || !menuElement) return
      const rect = viewport.getBoundingClientRect()
      const rowTop =
        viewport.querySelector<HTMLElement>(`#row-${position}`)?.getBoundingClientRect().top ??
        rect.top + HEADER
      menuElement.dataset.vscodeContext = context(row.index)
      menuElement.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          clientX: rect.left + Math.min(40, rect.width / 2),
          clientY: Math.max(rect.top + HEADER, Math.min(rect.bottom - ROW / 2, rowTop + ROW / 2)),
        }),
      )
    } catch (reason) {
      if (!signal.aborted && asked === source) error = describe(reason)
    }
  }
</script>

<div
  class="viewport"
  bind:this={viewport}
  role="grid"
  tabindex="0"
  aria-label="Case elements"
  aria-readonly="true"
  aria-rowcount={windowData.total + 1}
  aria-colcount={columns.length}
  aria-activedescendant={activeId}
  aria-busy={loading}
  onkeydown={keyboard}
  onscroll={() => {
    if (viewport) scrollTop = viewport.scrollTop
  }}
  data-vscode-context={context()}
>
  <div
    class="surface"
    style:width="{width}px"
    style:height="{HEADER + windowData.total * ROW}px"
    role="rowgroup"
  >
    <div class="heading row" role="row" aria-rowindex="1">
      {#each columns as column, i (column.id)}
        <div
          class="cell"
          class:identity={column.identity}
          role="columnheader"
          aria-colindex={i + 1}
          style:width="{columnWidth(column)}px"
          style:flex-basis="{columnWidth(column)}px"
          aria-sort={sort?.column === column.id
            ? sort.dir === 'asc'
              ? 'ascending'
              : 'descending'
            : 'none'}
          data-vscode-context={context(undefined, column)}
          title={column.id ?? 'Original element identifier'}
        >
          <button onclick={() => cycle(column.id)}>
            {column.label}
            <span
              class:ascending={sort?.dir === 'asc'}
              class:descending={sort?.dir === 'desc'}
              class:sort-mark={sort?.column === column.id}
            ></span>
          </button>
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (Focusable separators follow the ARIA splitter keyboard pattern.) -->
          <div
            class="resize"
            role="separator"
            tabindex="0"
            aria-label="Resize {column.label}"
            aria-orientation="vertical"
            aria-valuemin="70"
            aria-valuemax="800"
            aria-valuenow={columnWidth(column)}
            onpointerdown={(event) => startResize(event, column)}
            ondblclick={() => resize(column, column.width)}
            onkeydown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home') {
                event.preventDefault()
                resize(
                  column,
                  event.key === 'Home'
                    ? column.width
                    : columnWidth(column) + (event.key === 'ArrowRight' ? 10 : -10),
                )
              }
            }}
          ></div>
        </div>
      {/each}
    </div>
    {#each windowData.rows as row, i (row.index)}
      <div
        id="row-{renderedFirst + i}"
        class="row data-row"
        class:selected={selected === row.index}
        class:active={active === renderedFirst + i}
        role="row"
        tabindex="-1"
        onkeydown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            select(row.index, renderedFirst + i)
          }
        }}
        aria-rowindex={renderedFirst + i + 2}
        aria-selected={selected === row.index}
        style:top="{HEADER + (renderedFirst + i) * ROW}px"
        data-index={row.index}
        data-vscode-context={context(row.index)}
        onclick={() => select(row.index, renderedFirst + i)}
      >
        {#each columns as column, col (column.id)}
          {@const cell = column.index < 0 ? row.label : row.cells[column.index]}
          <div
            class="cell"
            class:identity={column.identity}
            class:numeric={column.numeric}
            role="gridcell"
            tabindex="-1"
            aria-colindex={col + 1}
            title={cell}
            style:width="{columnWidth(column)}px"
            style:flex-basis="{columnWidth(column)}px"
            data-vscode-context={context(row.index, column)}
            onclick={(event) => {
              event.stopPropagation()
              select(row.index, renderedFirst + i, column)
            }}
            onkeydown={(event) => {
              if (event.key === 'Enter') {
                event.stopPropagation()
                select(row.index, renderedFirst + i, column)
              }
            }}
          >
            {cell || '\u2014'}
          </div>
        {/each}
      </div>
    {/each}
  </div>
</div>
{#if error}<p class="notice" role="alert">{error}</p>
{:else if !loading && !windowData.total}<p class="notice" role="status">
    No rows match. Change or clear the filter.
  </p>{/if}
<div bind:this={menuElement} hidden aria-hidden="true"></div>

<script lang="ts">
  import type { GridSort, GridWindow } from '@latkit/model'
  import { onDestroy, untrack } from 'svelte'

  import { describe } from '../../errors.js'
  import { type Capabilities, menuContext } from '../../menus.js'
  import type { CaseTarget, Selection } from '../../targets.js'
  import { tableFieldId } from '../columns.js'
  import type { TableState } from '../messages.js'
  import { FrameQueue } from '../playback.js'
  import type { QuerySpec, Table } from '../query.js'
  import { WindowCache } from './window.js'
  let {
    source,
    tick = 0,
    time,
    frame,
    frameCount,
    focusRequest = 0,
    focusReady = 0,
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
    onfocusready,
  }: {
    tick?: number
    time?: number
    frame?: number
    frameCount?: number
    focusRequest?: number
    focusReady?: number
    source: Table | null
    query: string
    sort: GridSort | null
    scrollTop: number
    target?: CaseTarget
    classId: string
    columns: TableState['columns']
    widths: Record<string, number>
    capabilities: Capabilities
    selection: Selection | null
    onfocusready: (request: number) => void
    onselect: (selection: Selection) => void
    onstats: (total: number, time?: number) => void
  } = $props()
  const ROW = 28
  const HEADER = 32
  const OVERSCAN = 6
  let viewport = $state<HTMLDivElement>()
  let menuElement = $state<HTMLDivElement>()
  let height = $state(300)
  let viewportWidth = $state(800)
  let scrollLeft = $state(0)
  let cache = $state.raw<WindowCache | null>(null)
  let queue = $state.raw<FrameQueue<QuerySpec> | null>(null)
  let projection = $state.raw<readonly number[]>([])
  let windowData = $state.raw<GridWindow>({ rows: [], total: untrack(() => source?.rowCount ?? 0) })
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
  const layout = $derived.by(() => {
    let left = 0
    return columns.map((column, position) => {
      const width = columnWidth(column)
      const item = { column, position, left, width }
      left += width
      return item
    })
  })
  const painted = $derived(
    layout.filter(
      (item) =>
        item.column.identity ||
        (item.left + item.width >= scrollLeft - 200 &&
          item.left <= scrollLeft + viewportWidth + 200),
    ),
  )
  // Capping physical height avoids browser layout limits for multi-million-row cases.
  const surfaceHeight = $derived(Math.min(8_000_000, HEADER + windowData.total * ROW))
  const scale = $derived(
    Math.max(1, (HEADER + windowData.total * ROW - height) / Math.max(1, surfaceHeight - height)),
  )
  const shift = $derived(scrollTop - scrollTop / scale)
  const activeId = $derived(
    windowData.rows.some((_, i) => renderedFirst + i === active) ? `row-${active}` : undefined,
  )

  $effect(() => {
    const el = viewport
    if (!el) return
    const observer = new ResizeObserver(() => {
      height = el.clientHeight
      viewportWidth = el.clientWidth
    })
    observer.observe(el)
    el.scrollTop = untrack(() => scrollTop / scale)
    const wheel = (event: WheelEvent) => {
      if (scale === 1 || !event.deltaY || event.ctrlKey) return
      event.preventDefault()
      const unit = event.deltaMode === 1 ? ROW : event.deltaMode === 2 ? height - HEADER : 1
      scrollTop = Math.max(
        0,
        Math.min(HEADER + windowData.total * ROW - height, scrollTop + event.deltaY * unit),
      )
      el.scrollTop = scrollTop / scale
      el.scrollLeft += event.deltaX * unit
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      observer.disconnect()
      el.removeEventListener('wheel', wheel)
    }
  })
  $effect(() => {
    const table = source
    void query
    void sort
    const previous = untrack(() => cache)
    previous?.close()
    cache = null
    windowData = { rows: [], total: table?.rowCount ?? 0 }
    loading = !!table
    error = ''
    keyboardRead?.abort()
    if (!table) {
      queue = null
      return
    }
    const frames = new FrameQueue<QuerySpec>(
      async (spec, signal) => {
        const view = await table.query(spec, signal)
        if (cache?.view.frame === view.frame) {
          view.close()
          return
        }
        const next = new WindowCache(view)
        try {
          const offset = first
          const picked = painted.map((item) => item.column.index)
          const value = await next.read(offset, count, picked, signal)
          signal.throwIfAborted()
          const previous = cache
          cache = next
          windowData = value
          projection = picked
          renderedFirst = offset
          loading = false
          error = ''
          onstats(value.total, view.time)
          previous?.close()
        } catch (error) {
          next.close()
          throw error
        }
      },
      (reason) => {
        error = describe(reason)
        loading = false
      },
    )
    queue = frames
    return () => {
      frames.close()
      untrack(() => cache)?.close()
    }
  })
  $effect(() => {
    void tick
    const frames = queue
    if (frames) frames.request({ filter: query, sort, time, frame, frameCount })
  })
  $effect(() => {
    const pages = cache
    const offset = first
    const length = count
    const picked = painted.map((item) => item.column.index)
    if (!pages) return
    const controller = new AbortController()
    loading = true
    pages.read(offset, length, picked, controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return
        windowData = value
        projection = picked
        renderedFirst = offset
        loading = false
        error = ''
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
  // VS Code first loads this document in a hidden pending iframe. Request native
  // focus after its load handlers and the next layout frame have completed.
  let presented = $state(false)
  $effect(() => {
    let frame = 0
    const loaded = () => {
      frame = requestAnimationFrame(() => {
        presented = true
      })
    }
    if (document.readyState === 'complete') loaded()
    else window.addEventListener('load', loaded, { once: true })
    return () => {
      window.removeEventListener('load', loaded)
      cancelAnimationFrame(frame)
    }
  })
  let announced = 0
  $effect(() => {
    if (presented && focusRequest > announced && viewport && cache && !loading) {
      announced = focusRequest
      onfocusready(focusRequest)
    }
  })
  let focused = 0
  let windowFocused = $state(false)
  $effect(() => {
    const changed = () => {
      windowFocused = document.hasFocus()
    }
    window.addEventListener('focus', changed)
    window.addEventListener('blur', changed)
    changed()
    return () => {
      window.removeEventListener('focus', changed)
      window.removeEventListener('blur', changed)
    }
  })
  $effect(() => {
    void windowFocused
    if (presented && focusReady > focused && viewport && cache && !loading) {
      const element = viewport
      const request = focusReady
      const frame = requestAnimationFrame(() => {
        element.focus({ preventScroll: true })
        if (document.hasFocus()) {
          focused = request
          document.body.dataset.focus = String(focused)
        }
      })
      return () => cancelAnimationFrame(frame)
    }
  })
  $effect(() => {
    if (cache && viewport && Math.abs(viewport.scrollTop - scrollTop / scale) > 1)
      viewport.scrollTop = scrollTop / scale
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
  let previousBinding: string | undefined
  $effect(() => {
    const binding = JSON.stringify([target, classId])
    const key = JSON.stringify([query, sort])
    if (binding !== previousBinding) {
      keyboardRead?.abort()
      active = Math.floor(untrack(() => scrollTop) / ROW)
    } else if (previousFilter !== undefined && key !== previousFilter) {
      keyboardRead?.abort()
      active = 0
      scrollTop = 0
      if (viewport) viewport.scrollTop = 0
    }
    previousBinding = binding
    previousFilter = key
  })
  function move(position: number) {
    active = Math.max(0, Math.min(position, windowData.total - 1))
    const el = viewport
    if (!el) return
    keyboardRead?.abort()
    if (active * ROW < scrollTop) scrollTop = active * ROW
    else if ((active + 1) * ROW > scrollTop + el.clientHeight - HEADER)
      scrollTop = (active + 1) * ROW - el.clientHeight + HEADER
    el.scrollTop = scrollTop / scale
  }
  $effect(() => {
    const controller = new AbortController()
    const view = cache?.view
    if (selected !== null && view) {
      view.locate(selected, controller.signal).then(
        (position) => {
          if (!controller.signal.aborted && position !== null) move(position)
        },
        () => undefined,
      )
    }
    return () => controller.abort()
  })
  const context = (index?: number, column?: TableState['columns'][number]) =>
    !target || !source
      ? '{}'
      : JSON.stringify(
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
    if (!cache || !target) return
    active = position
    viewport?.focus()
    onselect({ element: { classId, index }, ...(column?.id && { field: column.field }) })
  }
  async function keyboard(event: KeyboardEvent) {
    if (event.target !== viewport || !cache || !target) return
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
    const asked = cache
    const filter = query
    const order = sort
    const position = active
    try {
      const visible = windowData.rows[position - renderedFirst]
      const row = visible ?? (await asked.read(position, 1, [], signal)).rows[0]
      if (
        signal.aborted ||
        asked !== cache ||
        filter !== query ||
        order !== sort ||
        position !== active
      )
        return
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
      if (!signal.aborted && asked === cache) error = describe(reason)
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
  aria-disabled={!source}
  class:unavailable={!source}
  onkeydown={keyboard}
  onscroll={() => {
    if (viewport) {
      scrollLeft = viewport.scrollLeft
      if (source && cache) scrollTop = viewport.scrollTop * scale
    }
  }}
  data-vscode-context={context()}
>
  <div class="surface" style:width="{width}px" style:height="{surfaceHeight}px" role="rowgroup">
    <div class="heading row" role="row" aria-rowindex="1">
      {#each painted as item (item.column.id)}
        {@const { column, position: i, left } = item}
        <div
          class="cell"
          class:identity={column.identity}
          style:position={column.identity ? 'sticky' : 'absolute'}
          style:left="{column.identity ? 0 : left}px"
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
        style:top="{HEADER + (renderedFirst + i) * ROW - shift}px"
        data-index={row.index}
        data-vscode-context={context(row.index)}
        onclick={() => select(row.index, renderedFirst + i)}
      >
        {#each painted as item (item.column.id)}
          {@const { column, position: col, left } = item}
          {@const cell = row.cells[projection.indexOf(column.index)]}
          <div
            class="cell"
            class:identity={column.identity}
            style:position={column.identity ? 'sticky' : 'absolute'}
            style:left="{column.identity ? 0 : left}px"
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
{:else if source && !loading && !windowData.total}<p class="notice" role="status">
    No rows match. Change or clear the filter.
  </p>{/if}
<div bind:this={menuElement} hidden aria-hidden="true"></div>

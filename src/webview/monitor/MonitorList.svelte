<!-- @component The monitors, listed at the Monitor's side as the Terminal lists its terminals: one
row per recorded signal, the shown ones selected. Click shows a monitor, double click or Enter also
focuses its plot, and a row's menu holds the rest. -->
<script module lang="ts">
  /** The list's width until the user drags its edge. */
  export const LIST_WIDTH = 200
</script>

<script lang="ts">
  import { CHANNELS, channelsOf } from '../../shared/mappings.js'
  import type { Monitor, ViewState } from '../../shared/messages.js'
  import { monitorName, sameField } from '../../shared/monitors.js'
  import { contextOf, nativeMenu } from '../menu.js'
  import Icon from '../ui/Icon.svelte'

  /** Below this width, rows show only their icons. */
  const NARROW = 96

  let {
    viewState,
    width = $bindable(LIST_WIDTH),
    onshow,
    onsplit,
    onunsplit,
    onopen,
  }: {
    viewState: ViewState
    /** The list's width in CSS pixels, set by dragging its edge. */
    width?: number
    onshow: (monitor: Monitor) => void
    onsplit: (monitor: Monitor) => void
    onunsplit: (monitor: Monitor) => void
    /** Shows the monitor and focuses its plot. */
    onopen: (monitor: Monitor) => void
  } = $props()

  const id = $props.id()
  const monitors = $derived(viewState.monitors ?? [])
  const shown = $derived(viewState.shown ?? [])
  const narrow = $derived(width < NARROW)
  /** The row the keyboard is on. */
  let focus = $state(0)
  let list = $state<HTMLElement>()
  let dragging = $state(false)

  const isShown = (monitor: Monitor) => shown.some((each) => sameField(each, monitor))
  const nameOf = (monitor: Monitor) => monitorName(viewState.summary?.definition, monitor)
  const channels = (monitor: Monitor) =>
    channelsOf(viewState.mappings ?? {}, monitor).map((channel) => CHANNELS[channel].label)
  const menuOf = (monitor: Monitor) => contextOf(viewState, 'monitor', undefined, monitor)
  /** The menu of the list itself, where no row is: as the Terminal's tab list offers new and
   *  split terminals, it offers what the Monitor's title bar does for monitors. */
  const listMenu = $derived(JSON.stringify(contextOf(viewState, 'monitor')))

  /** Keeps the keyboard row on a monitor that exists. */
  $effect(() => {
    if (focus >= monitors.length) focus = Math.max(0, monitors.length - 1)
  })

  function keydown(event: KeyboardEvent) {
    const monitor = monitors[focus]
    if (!monitor) return
    const step: Record<string, number> = {
      ArrowUp: focus - 1,
      ArrowDown: focus + 1,
      Home: 0,
      End: monitors.length - 1,
      PageUp: 0,
      PageDown: monitors.length - 1,
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key in step) {
      focus = Math.max(0, Math.min(monitors.length - 1, step[event.key]!))
      list?.querySelector(`#${CSS.escape(rowId(focus))}`)?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'Enter') onopen(monitor)
    else if (event.key === ' ') onshow(monitor)
    else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      const row = list?.querySelector<HTMLElement>(`#${CSS.escape(rowId(focus))}`)
      if (row) nativeMenu(row, [row.clientWidth / 2, row.clientHeight], menuOf(monitor))
    } else return
    event.preventDefault()
  }

  /** Drags the list's edge; the plots take the rest of the width. */
  function resize(event: PointerEvent) {
    if (event.button !== 0) return
    const sash = event.currentTarget as HTMLElement
    const start = event.clientX
    const from = width
    const limit = (sash.closest('.monitor') as HTMLElement | null)?.clientWidth ?? Infinity
    dragging = true
    sash.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) => {
      width = Math.round(Math.max(28, Math.min(limit - 120, from + start - next.clientX)))
    }
    const end = () => {
      dragging = false
      sash.removeEventListener('pointermove', move)
      sash.removeEventListener('pointerup', end)
      sash.removeEventListener('pointercancel', end)
    }
    sash.addEventListener('pointermove', move)
    sash.addEventListener('pointerup', end)
    sash.addEventListener('pointercancel', end)
  }

  const rowId = (index: number) => `${id}-${index}`
</script>

<div class="monitors" class:monitors--narrow={narrow} style:inline-size="{width}px">
  <!-- svelte-ignore a11y_no_static_element_interactions (A pointer handle; the list resizes with the panel.) -->
  <div
    class="monitors__sash"
    class:monitors__sash--active={dragging}
    onpointerdown={resize}
    ondblclick={() => (width = LIST_WIDTH)}
  ></div>
  <div
    class="monitors__rows"
    role="listbox"
    aria-label="Monitors"
    aria-multiselectable="true"
    aria-activedescendant={monitors.length ? rowId(focus) : undefined}
    tabindex="0"
    data-vscode-context={listMenu}
    bind:this={list}
    onkeydown={keydown}
  >
    {#each monitors as monitor, index (`${monitor.table}.${monitor.field}`)}
      {@const selected = isShown(monitor)}
      {@const mapped = channels(monitor)}
      <!-- svelte-ignore a11y_click_events_have_key_events (The listbox handles the keys for its rows.) -->
      <div
        id={rowId(index)}
        class="monitor-row"
        class:monitor-row--focused={index === focus}
        role="option"
        tabindex="-1"
        aria-selected={selected}
        title={nameOf(monitor)}
        data-vscode-context={JSON.stringify(menuOf(monitor))}
        onclick={() => {
          focus = index
          onshow(monitor)
        }}
        ondblclick={() => onopen(monitor)}
      >
        <span class="monitor-row__icon"><Icon name="graph" /></span>
        {#if !narrow}
          <span class="monitor-row__name">{nameOf(monitor)}</span>
          {#if mapped.length}
            <span class="monitor-row__status" title={'On the Network as ' + mapped.join(', ')}>
              <Icon name="mapped" />
            </span>
          {/if}
          {#if selected ? shown.length > 1 : monitors.length > 1}
            <button
              class="c-icon-btn monitor-row__action"
              type="button"
              tabindex="-1"
              title={selected ? 'Unsplit Monitor' : 'Split Monitor'}
              aria-label={`${selected ? 'Unsplit' : 'Split'} ${nameOf(monitor)}`}
              onclick={(event) => {
                event.stopPropagation()
                if (selected) onunsplit(monitor)
                else onsplit(monitor)
              }}
              ondblclick={(event) => event.stopPropagation()}
            >
              <Icon name={selected ? 'close' : 'split'} />
            </button>
          {/if}
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .monitors {
    position: relative;
    display: flex;
    flex: none;
    flex-direction: column;
    min-inline-size: 0;
    border-inline-start: 1px solid var(--color-border);
  }

  /* The edge that resizes the list, highlighted as VS Code highlights its sashes. */
  .monitors__sash {
    position: absolute;
    z-index: 1;
    inset-block: 0;
    inset-inline-start: -3px;
    inline-size: 5px;
    cursor: ew-resize;
    transition: background-color var(--motion-mid) var(--motion-hover);
  }

  .monitors__sash:hover,
  .monitors__sash--active {
    background: var(--vscode-sash-hoverBorder, var(--color-focus-ring));
  }

  .monitors__rows {
    flex: 1;
    min-block-size: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .monitors__rows:focus-visible {
    outline: 1px solid var(--color-focus-ring);
    outline-offset: -1px;
  }

  /* Rows as VS Code draws its lists: 22 pixels tall, its hover and selection colors. */
  .monitor-row {
    display: flex;
    align-items: center;
    gap: 6px;
    block-size: 22px;
    padding-inline: var(--spacing-sm) var(--spacing-2xs);
    color: var(--color-text-1);
    cursor: pointer;
    user-select: none;
  }

  .monitor-row:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .monitor-row[aria-selected='true'] {
    background: var(--vscode-list-inactiveSelectionBackground);
    color: var(--vscode-list-inactiveSelectionForeground, var(--color-text-1));
    box-shadow: inset 1px 0 var(--vscode-terminal-tab-activeBorder, transparent);
  }

  .monitors__rows:focus .monitor-row[aria-selected='true'] {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground, var(--color-text-1));
  }

  .monitors__rows:focus .monitor-row--focused {
    outline: 1px solid var(--vscode-list-focusOutline, var(--color-focus-ring));
    outline-offset: -1px;
  }

  .monitor-row__icon,
  .monitor-row__status {
    display: inline-flex;
    flex: none;
  }

  .monitor-row__status {
    color: var(--color-text-2);
  }

  .monitor-row__icon :global(svg),
  .monitor-row__status :global(svg) {
    inline-size: 16px;
    block-size: 16px;
  }

  .monitor-row__name {
    flex: 1;
    min-inline-size: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .monitor-row__action {
    visibility: hidden;
    min-inline-size: 20px;
    min-block-size: 20px;
    border-radius: var(--radius-sm);
    color: inherit;
  }

  .monitor-row__action :global(svg) {
    inline-size: 14px;
    block-size: 14px;
  }

  .monitor-row:hover .monitor-row__action,
  .monitors__rows:focus .monitor-row--focused .monitor-row__action {
    visibility: visible;
  }

  .monitors--narrow .monitor-row {
    justify-content: center;
    padding-inline: 0;
  }
</style>

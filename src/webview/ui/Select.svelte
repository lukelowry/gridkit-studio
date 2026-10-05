<!-- @component
  Bindable combobox; long lists add search and mount only the rows in view. Extra attributes go to
  the trigger.
-->
<script lang="ts" generics="T">
  import { untrack } from 'svelte'
  import type { HTMLButtonAttributes } from 'svelte/elements'

  import { ListCursor } from './cursor.svelte.js'
  import Icon from './Icon.svelte'
  import {
    indexOptions,
    layoutOptions,
    type OptionRow,
    type SelectOption,
    windowRuns,
  } from './listbox.js'
  import { Viewport } from './viewport.svelte.js'

  let {
    options,
    value = $bindable(null),
    key = String,
    label,
    placeholder = 'None',
    clearable = false,
    disabled = false,
    compact = false,
    hideLabel = false,
    ...rest
  }: Omit<HTMLButtonAttributes, 'children' | 'class' | 'value'> & {
    readonly options: ReadonlyArray<SelectOption<T>>
    /** Null shows the placeholder. */
    value?: T | null
    /** Tells values apart; `String` by default. */
    readonly key?: (value: T) => string
    /** The row label, and the start of the trigger's accessible name. */
    readonly label: string
    /** Shown while nothing is selected, and as the clear row's label. */
    readonly placeholder?: string
    /** Lead the list with a clear row that sets null. */
    readonly clearable?: boolean
    readonly disabled?: boolean
    /** Inline and sized to its content, for toolbars. */
    readonly compact?: boolean
    /** Keep the label for assistive technology only. */
    readonly hideLabel?: boolean
  } = $props()

  /** Past this many options, the list adds search and windowing. */
  const SEARCH_AT = 50

  const id = $props.id()
  const anchorName = `--${id}`
  // The guesses match --select-row-height and the popup's max height until measured.
  const viewport = new Viewport(4, { rowHeight: 36, height: 320 })

  /** Opening sets it; any change to `disabled` closes the list. */
  let open = $derived.by(() => {
    void disabled
    return false
  })
  /** The last move came from the keyboard, so the active row draws a ring. */
  let keyboard = $state(false)
  let query = $state('')

  let root = $state<HTMLElement>()
  let trigger = $state<HTMLButtonElement>()
  let popup = $state<HTMLElement>()
  let list = $state<HTMLElement>()
  let probe = $state<HTMLElement>()
  let search = $state<HTMLInputElement>()

  const index = $derived(indexOptions(options, key))
  const searchable = $derived(options.length > SEARCH_AT)
  const chosen = $derived(value === null ? null : key(value))
  const current = $derived(chosen === null ? undefined : index.byKey.get(chosen))
  const layout = $derived(layoutOptions(index, clearable ? placeholder : null, query))
  const cursor = new ListCursor({
    count: () => layout.nav.length,
    text: (nav) => layout.nav[nav]!.text,
  })
  const activeRow = $derived<OptionRow<T> | undefined>(
    layout.nav[Math.min(cursor.active, layout.nav.length - 1)],
  )
  const activeId = $derived(open && activeRow ? optionId(activeRow) : undefined)
  // Short lists mount every row, so find in page reaches each option; long ones mount a window.
  const runs = $derived(
    searchable
      ? windowRuns(layout, viewport.first, viewport.count, activeRow)
      : windowRuns(layout, 0, layout.slots.length),
  )

  function optionId(row: OptionRow<T>): string {
    return `${id}-o${row.nav}`
  }

  function show(): void {
    query = ''
    cursor.reset()
    keyboard = false
    cursor.active = layout.navOf.get(chosen) ?? 0
    open = true
  }

  function hide(returnFocus: boolean): void {
    open = false
    cursor.reset()
    if (returnFocus) trigger?.focus()
  }

  /** Keep focus put on presses in the open list or trigger, bar the search field: pressing what
   *  takes no focus, or a button in macOS Safari or Firefox, would blur and close the list. */
  function holdFocus(event: MouseEvent): void {
    if (open && event.target !== search) event.preventDefault()
  }

  function choose(row: OptionRow<T>): void {
    value = row.value
    hide(true)
  }

  /** Move the cursor to the hovered row, and title a clipped label with its full text. */
  function point(row: OptionRow<T>, element: HTMLElement): void {
    const text = element.querySelector('.select__value')
    element.title = text !== null && text.scrollWidth > text.clientWidth ? row.label : ''
    keyboard = false
    cursor.active = row.nav
  }

  /** Scroll `row` into view, or center it, by arithmetic: it may not be mounted. A named group's
   *  sticky heading covers the top slot, so the row must clear it. */
  function reveal(row: OptionRow<T>, center: boolean): void {
    const height = viewport.rowHeight
    const heading = row.group.label === '' ? 0 : height
    if (center) viewport.reveal(row.slot * height, height, true)
    else viewport.reveal(row.slot * height - heading, height + heading)
  }

  function filter(text: string): void {
    query = text
    keyboard = true
    cursor.active = 0
    viewport.rewind()
  }

  function keydown(event: KeyboardEvent): void {
    if (disabled || event.isComposing) return
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault()
        show()
      }
      return
    }
    const inField = event.currentTarget === search
    switch (event.key) {
      case 'Enter':
      case ' ':
        if (event.key === ' ' && inField) return
        event.preventDefault()
        if (activeRow) choose(activeRow)
        return
      case 'Escape':
        // Consumed, so enclosing handlers do not also act on it.
        event.preventDefault()
        event.stopPropagation()
        hide(true)
        return
      case 'Tab':
        // Leaving the search field unmounts it, so tab order resumes from the trigger.
        hide(inField)
        return
      case 'Home':
      case 'End':
        // In the search field these move the caret unless Ctrl is held.
        if (inField && !event.ctrlKey) return
        break
      default:
        // In the search field, printable keys edit the query.
        if (inField && event.key.length === 1) return
    }
    const page = Math.max(1, Math.floor(viewport.height / viewport.rowHeight))
    if (!cursor.key(event, page)) return
    event.preventDefault()
    keyboard = true
    if (activeRow) reveal(activeRow, false)
  }

  function leave(event: FocusEvent): void {
    if (open && !root?.contains(event.relatedTarget as Node | null)) hide(false)
  }

  // While open: show the popover, track its size and scroll, center the selection, and focus the
  // search field.
  $effect(() => {
    if (!open || !popup || !list || !probe) return
    popup.showPopover()
    const stop = viewport.follow(list, probe)
    untrack(() => {
      if (activeRow) reveal(activeRow, true)
      search?.focus()
    })
    return stop
  })
</script>

<div class="select" bind:this={root} onfocusout={leave}>
  <button
    {...rest}
    type="button"
    role="combobox"
    class={[
      'c-row',
      'select__trigger',
      compact && 'select__trigger--compact',
      hideLabel && 'select__trigger--unlabeled',
    ]}
    aria-labelledby={`${id}-label ${id}-value`}
    aria-haspopup={searchable ? 'dialog' : 'listbox'}
    aria-expanded={open}
    aria-controls={searchable ? `${id}-popup` : `${id}-list`}
    aria-activedescendant={searchable ? undefined : activeId}
    popovertarget={`${id}-popup`}
    {disabled}
    bind:this={trigger}
    onmousedown={holdFocus}
    onclick={(event) => {
      // Toggled here; as the popover's invoker the trigger only keeps a press on it from
      // light-dismissing the list.
      event.preventDefault()
      if (open) hide(true)
      else if (!disabled) show()
    }}
    onkeydown={keydown}
  >
    <span id={`${id}-label`} class={hideLabel ? 'c-sr-only' : 'c-row__label'}>
      {label}
    </span>
    <span class="select__control" style:anchor-name={anchorName}>
      <span
        id={`${id}-value`}
        class={['select__value', current === undefined && 'select__value--empty']}
      >
        {current?.label ?? placeholder}
      </span>
      <span class="select__chev"><Icon name="chevron" /></span>
    </span>
  </button>

  {#if open}
    <div
      id={`${id}-popup`}
      class="select__popup"
      popover="auto"
      role={searchable ? 'dialog' : undefined}
      aria-labelledby={searchable ? `${id}-label` : undefined}
      style:position-anchor={anchorName}
      bind:this={popup}
      onmousedown={holdFocus}
      ontoggle={(event) => {
        if (event.newState === 'closed' && open) hide(false)
      }}
    >
      {#if searchable}
        <div class="select__search">
          <input
            type="text"
            role="combobox"
            class="c-input"
            placeholder="Search"
            autocomplete="off"
            spellcheck="false"
            aria-label={`Search ${label}`}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={activeId}
            value={query}
            bind:this={search}
            oninput={(event) => filter(event.currentTarget.value)}
            onkeydown={keydown}
          />
        </div>
      {/if}
      <div class="select__measure" aria-hidden="true" bind:this={probe}></div>
      <div
        id={`${id}-list`}
        class="select__list"
        role="listbox"
        aria-labelledby={`${id}-label`}
        bind:this={list}
      >
        <div class="select__space" style:--rows={layout.slots.length}>
          {#each runs as run (run.group.start)}
            {@const heading = run.group.label}
            <div
              class="select__group-wrap"
              role={heading ? 'group' : undefined}
              aria-label={heading || undefined}
              style:--at={run.group.start}
              style:--rows={run.group.end - run.group.start}
            >
              {#if heading}<div class="select__group" aria-hidden="true">{heading}</div>{/if}
              {#each run.rows as row (row.slot)}{@render option(row)}{/each}
            </div>
          {/each}
        </div>
      </div>
      <!-- Mounted with the search field, so screen readers announce its changes. -->
      {#if searchable}
        <p class="select__empty" role="status">
          {query !== '' && layout.slots.length === 0 ? 'No matches' : ''}
        </p>
      {/if}
    </div>
  {/if}
</div>

{#snippet option(row: OptionRow<T>)}
  {@const selected = row.key === chosen}
  <!-- svelte-ignore a11y_click_events_have_key_events (the combobox's keydown handler chooses the active option) -->
  <div
    role="option"
    class={[
      'select__opt',
      row.key === null && 'select__opt--clear',
      row === activeRow && 'select__opt--active',
      row === activeRow && keyboard && 'select__opt--cursor',
    ]}
    id={optionId(row)}
    tabindex={-1}
    aria-selected={selected}
    aria-posinset={row.posinset}
    aria-setsize={row.group.setsize}
    data-value={row.key ?? undefined}
    style:--at={row.slot - row.group.start}
    onpointerenter={(event) => point(row, event.currentTarget)}
    onclick={() => choose(row)}
  >
    <span class="select__value">{row.label}</span>
    <span class="select__mark" aria-hidden="true">
      {#if selected}<Icon name="check" />{/if}
    </span>
  </div>
{/snippet}

<style>
  .select {
    display: contents;
  }

  /* An instrument row (the c-row grid, hover and focus): label left, unboxed value right. */
  .select__trigger {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr);
    border: 0;
    border-radius: var(--radius-lg);
    color: var(--color-text-1);
    text-align: start;
  }

  .select__trigger:disabled:hover {
    background: transparent;
    color: var(--color-text-2);
  }

  .select__control {
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-sm);
    min-inline-size: 0;
    min-block-size: 2rem;
    padding: var(--spacing-xs) var(--spacing-md);
    border: 0;
    border-radius: var(--radius-lg);
    background: var(--color-surface-2);
    font-family: var(--font-body);
    font-size: var(--text-sm);
    transition: background-color var(--motion-mid) var(--motion-hover);
  }

  .select__trigger:hover:not(:disabled) .select__control,
  .select__trigger[aria-expanded='true'] .select__control {
    background: var(--color-selected);
  }

  .select__value {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .select__value--empty {
    color: var(--color-text-2);
  }

  .select__chev {
    display: flex;
    flex-shrink: 0;
    color: var(--color-text-2);
    transition: transform var(--motion-fast) var(--motion-hover);
  }

  .select__chev :global(svg) {
    inline-size: 0.75rem;
    block-size: 0.75rem;
  }

  .select__trigger[aria-expanded='true'] .select__chev {
    color: var(--color-primary-text);
    transform: rotate(180deg);
  }

  .select__trigger.select__trigger--compact {
    display: inline-flex;
    flex: 0 0 auto;
    gap: var(--spacing-sm);
    inline-size: auto;
    min-block-size: 2rem;
    padding: var(--spacing-xs) var(--spacing-sm);
    background: var(--color-surface-2);
  }

  .select__trigger--compact .select__control {
    min-block-size: 0;
    padding: 0;
    background: transparent;
  }

  .select__trigger--compact .select__value {
    white-space: nowrap;
  }

  /* Unlabeled: the value takes the whole row. */
  .select__trigger.select__trigger--unlabeled {
    grid-template-columns: minmax(0, 1fr);
    inline-size: 100%;
    min-inline-size: 0;
  }

  .select__trigger--unlabeled .select__control {
    flex: 1;
  }

  /* An auto popover under the value and at least as wide. It flips above or leftward where there is
     no room, and where neither side fits whole, shrinks to the room below, else above. */
  .select__popup {
    --select-row-height: 2.25rem;
    inset: auto;
    inline-size: max(anchor-size(inline), 13.75rem);
    max-inline-size: calc(100vw - 2 * var(--spacing-sm));
    max-block-size: 20rem;
    margin: var(--spacing-xs) 0;
    padding: var(--spacing-xs);
    overflow: hidden;
    border: 0;
    border-radius: var(--radius-lg);
    background: var(--color-surface-2);
    box-shadow: var(--shadow-overlay);
    animation: drop var(--motion-mid) var(--motion-entrance);
    position-area: block-end span-inline-end;
    position-try-fallbacks:
      flip-block,
      flip-inline,
      flip-block flip-inline,
      --select-shrink-below,
      --select-shrink-above;
  }

  @position-try --select-shrink-below {
    position-area: block-end span-inline-end;
    min-block-size: 7.5rem;
    max-block-size: 100%;
  }

  @position-try --select-shrink-above {
    position-area: block-start span-inline-end;
    min-block-size: 7.5rem;
    max-block-size: 100%;
  }

  .select__popup:popover-open {
    display: flex;
    flex-direction: column;
  }

  @keyframes drop {
    from {
      opacity: 0;
      transform: translateY(-0.25rem);
    }

    to {
      opacity: 1;
      transform: none;
    }
  }

  .select__search {
    flex: none;
    padding: var(--spacing-xs);
  }

  .select__list {
    min-block-size: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .select__measure {
    position: absolute;
    block-size: var(--select-row-height);
    visibility: hidden;
    pointer-events: none;
  }

  .select__empty {
    padding: var(--spacing-sm);
    color: var(--color-text-2);
    font-size: var(--text-sm);
  }

  .select__empty:empty {
    padding: 0;
  }

  /* Custom properties place every row and heading, so layout never waits on measurement, which only
     picks the rows to mount. */
  .select__space {
    position: relative;
    block-size: calc(var(--rows) * var(--select-row-height));
  }

  .select__group-wrap,
  .select__opt {
    position: absolute;
    inset-inline: 0;
    inset-block-start: calc(var(--at) * var(--select-row-height));
  }

  .select__group-wrap {
    block-size: calc(var(--rows) * var(--select-row-height));
  }

  .select__group {
    position: sticky;
    inset-block-start: 0;
    z-index: 1;
    block-size: var(--select-row-height);
    padding: var(--spacing-xs) var(--spacing-sm) var(--spacing-2xs);
    overflow: hidden;
    background: var(--color-surface-2);
    color: var(--color-text-2);
    font-family: var(--font-body);
    font-size: var(--text-xs);
    font-weight: 500;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .select__opt {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    block-size: var(--select-row-height);
    padding: var(--spacing-xs) var(--spacing-sm);
    border-radius: var(--radius-md);
    color: var(--color-text-2);
    font-family: var(--font-body);
    font-size: var(--text-sm);
    cursor: pointer;
    transition:
      background-color var(--motion-fast) var(--motion-hover),
      color var(--motion-fast) var(--motion-hover);
  }

  /* One line per row; a clipped label's full text is the row's title. */
  .select__opt .select__value {
    flex: 1;
    white-space: nowrap;
    overflow-wrap: normal;
  }

  .select__opt--clear {
    border-block-end: 1px solid color-mix(in oklch, var(--color-border) 45%, transparent);
  }

  /* The cursor, from the keyboard or the pointer. */
  .select__opt--active {
    background: var(--color-row-hover);
    color: var(--color-text-1);
  }

  /* The selection tint overrides the cursor's; a keyboard ring still draws over it. */
  .select__opt[aria-selected='true'] {
    background: var(--color-selected);
    color: var(--color-text-1);
    font-weight: 500;
  }

  /* Only the keyboard cursor gets a ring, inset, since real focus stays on the trigger. */
  .select__opt--cursor {
    outline: var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-width));
  }

  .select__mark {
    display: flex;
    flex-shrink: 0;
    inline-size: 1rem;
    color: var(--color-primary-text);
    visibility: hidden;
  }

  .select__opt[aria-selected='true'] .select__mark {
    visibility: visible;
  }

  @media (pointer: coarse) {
    .select__popup {
      --select-row-height: var(--spacing-touch-h);
    }

    .select__trigger.select__trigger--compact {
      min-block-size: var(--spacing-touch-h);
    }
  }

  @media (forced-colors: active) {
    .select__opt[aria-selected='true'] {
      background: Highlight;
      color: HighlightText;
      forced-color-adjust: none;
    }

    .select__opt--cursor {
      outline-color: Highlight;
    }
  }

  @container settings (max-width: 20rem) {
    .select__trigger {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>

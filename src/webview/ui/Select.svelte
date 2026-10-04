<!-- @component
  Bindable combobox; large lists add search and virtualization. Keep the active option mounted for aria-activedescendant.
  Extra attributes target the trigger. Search keys edit text; Ctrl+Home/End navigate options.
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
    field = false,
    class: className,
    ...rest
  }: Omit<HTMLButtonAttributes, 'children' | 'value'> & {
    readonly options: ReadonlyArray<SelectOption<T>>
    /** The selected value; null shows the placeholder, and the clear row sets it. */
    value?: T | null
    /** The text that tells values apart, `String` unless given. */
    readonly key?: (value: T) => string
    /** The row label, and the start of the combobox's accessible name. */
    readonly label: string
    /** Shown while nothing is selected, and as the clear row's label. */
    readonly placeholder?: string
    /** Lead the list with a clear row that sets null. */
    readonly clearable?: boolean
    readonly disabled?: boolean
    /** Label and value inline and hugging their content, for toolbars. */
    readonly compact?: boolean
    /** Keep the label for assistive technology only. */
    readonly hideLabel?: boolean
    /** A form field: the value alone in a boxed c-field, the label for assistive technology only. */
    readonly field?: boolean
  } = $props()

  /** Past this many options, a list is searched and windowed instead of mounted whole. */
  const SEARCH_AT = 50

  const id = $props.id()
  const anchorName = `--${id}`
  const viewport = new Viewport(4, { rowHeight: 36, height: 320 })

  /** Whether the list shows. Opening sets it; any change to `disabled` closes the list again. */
  let open = $derived.by(() => {
    void disabled
    return false
  })
  /** The last move came from the keyboard, so the active row shows a cursor ring. */
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
  // Only a clearable select turns its placeholder into a row.
  const layout = $derived(layoutOptions(index, clearable ? placeholder : null, query))
  const cursor = new ListCursor({
    count: () => layout.nav.length,
    text: (nav) => layout.nav[nav]!.text,
  })
  const activeRow = $derived<OptionRow<T> | undefined>(
    layout.nav[Math.min(cursor.active, layout.nav.length - 1)],
  )
  const activeId = $derived(open && activeRow ? optionId(activeRow) : undefined)
  // A short list mounts whole, so each option can be found in the page; a long one mounts its window.
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

  /**
   * A press on the open list or its trigger leaves focus where it is (on the trigger, or in the
   * search field, which alone takes presses). A press on a heading, the padding or the scrollbar
   * would otherwise hand focus to the page and the focusout would close the list; and Safari and
   * Firefox on macOS never focus a pressed button, so a press on the trigger would close the list
   * for the click to open it again. Scrolling and clicks are unaffected.
   */
  function holdFocus(event: MouseEvent): void {
    if (open && event.target !== search) event.preventDefault()
  }

  function choose(row: OptionRow<T>): void {
    if (row.nav < 0) return
    value = row.value
    hide(true)
  }

  /** The pointer's cursor. A label the row clips gets its full text as the row's tooltip. */
  function point(row: OptionRow<T>, element: HTMLElement): void {
    const text = element.querySelector('.select__value')
    element.title = text !== null && text.scrollWidth > text.clientWidth ? row.label : ''
    if (row.nav < 0) return
    keyboard = false
    cursor.active = row.nav
  }

  /** Scroll `row` into view, or to the middle, by arithmetic: it may not be mounted. A named group's
   *  sticky heading covers the top slot of the view, so the row must clear it. */
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
        // Consumed here, so the Dock does not also read it as dismissing a panel.
        event.preventDefault()
        event.stopPropagation()
        hide(true)
        return
      case 'Tab':
        // Leaving the search field removes it, so native tab order resumes from the trigger.
        hide(inField)
        return
      case 'Home':
      case 'End':
        // In the search field these move the caret; with Ctrl they move through the results.
        if (inField && !event.ctrlKey) return
        break
      default:
        // In the search field, characters are the query's.
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

  // While open: show the list in the top layer, follow its size and scroll, center the selection
  // and hand focus to the search field.
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
      (hideLabel || field) && 'select__trigger--unlabeled',
      field && 'select__trigger--field',
      className,
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
      // The trigger opens and closes the list itself; as the list's invoker it only keeps a press
      // on it from counting as a press outside.
      event.preventDefault()
      if (open) hide(true)
      else if (!disabled) show()
    }}
    onkeydown={keydown}
  >
    <span id={`${id}-label`} class={hideLabel || field ? 'c-sr-only' : 'c-row__label'}>
      {label}
    </span>
    <span class={['select__control', field && 'c-field']} style:anchor-name={anchorName}>
      {@render swatch(current?.swatch)}
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
      <!-- Mounted with the search field, so a screen reader hears the text change. -->
      {#if searchable}
        <p class="select__empty" role="status">
          {query !== '' && layout.slots.length === 0 ? 'No matches' : ''}
        </p>
      {/if}
    </div>
  {/if}
</div>

{#snippet swatch(background: string | undefined)}
  {#if background}<span class="select__swatch" style:background></span>{/if}
{/snippet}

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
      row.option?.disabled && 'select__opt--disabled',
    ]}
    id={row.nav < 0 ? undefined : optionId(row)}
    tabindex={-1}
    aria-selected={selected}
    aria-disabled={row.option?.disabled ? true : undefined}
    aria-posinset={row.posinset}
    aria-setsize={row.group.setsize}
    data-value={row.key ?? undefined}
    data-part={row.key === null ? 'clear' : undefined}
    style:--at={row.slot - row.group.start}
    onpointerenter={(event) => point(row, event.currentTarget)}
    onclick={() => choose(row)}
  >
    {@render swatch(row.option?.swatch)}
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

  /* The trigger is an instrument row (the c-row grid, hover and focus), so a picker reads like a
     Switch: label left, value right, no boxed field. */
  .select__trigger {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr);
    border: 0;
    border-radius: var(--radius-lg);
    color: var(--color-text-1);
    text-align: start;
  }

  .select__trigger .c-row__label {
    font-weight: 500;
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
    color: var(--color-text-3);
  }

  .select__chev {
    display: flex;
    flex-shrink: 0;
    color: var(--color-text-3);
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

  /* Compact: label and value inline, hugging their content, for a toolbar. */
  .select__trigger.select__trigger--compact {
    display: inline-flex;
    flex: 0 0 auto;
    gap: var(--spacing-sm);
    inline-size: auto;
    min-height: 2rem;
    min-block-size: 2rem;
    padding: var(--spacing-xs) var(--spacing-sm);
    background: var(--color-surface-2);
  }

  .select__trigger--compact .c-row__label {
    color: var(--color-text-2);
    font-size: var(--text-sm);
    white-space: nowrap;
  }

  .select__trigger--compact .select__control {
    min-block-size: 0;
    padding: 0;
    background: transparent;
  }

  .select__trigger--compact .select__value {
    white-space: nowrap;
  }

  /* Unlabeled: the value control takes the whole row. */
  .select__trigger.select__trigger--unlabeled {
    grid-template-columns: minmax(0, 1fr);
    inline-size: 100%;
    min-inline-size: 0;
  }

  .select__trigger--unlabeled .select__control {
    flex: 1;
  }

  /* Field: the trigger is the c-field box itself, one row tall, with no row around it. Hover and an
     open list mark the border as a field's focus does; the ring sits over the border. */
  .select__trigger.select__trigger--field {
    min-height: 0;
    padding: 0;
    border-radius: var(--radius-md);
    background: transparent;
  }

  .select__trigger--field:focus-visible {
    outline-offset: -1px;
  }

  /* The control's own rules above outrank the c-field layer, so the box is restated here. */
  .select__trigger--field .select__control {
    min-block-size: var(--spacing-row-h);
    padding: 0 var(--spacing-sm);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    transition: border-color var(--motion-fast) var(--motion-hover);
  }

  .select__trigger--field .select__value {
    flex: 1;
    white-space: nowrap;
    overflow-wrap: normal;
  }

  .select__trigger--field:hover:not(:disabled) .select__control {
    border-color: var(--color-text-3);
    background: var(--color-surface-2);
  }

  .select__trigger--field[aria-expanded='true'] .select__control {
    border-color: var(--color-primary-text);
    background: var(--color-surface-2);
  }

  /* A swatch keeps a hairline neutral frame, so a ramp that ends near white or near black never
     dissolves into the surface. */
  .select__swatch {
    flex-shrink: 0;
    inline-size: 1.75rem;
    block-size: 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
  }

  /* The list, an auto popover in the top layer, anchored to the value control: at least as wide as
     the control and 220px, below it and at most 320px tall. It flips above (keeping its bottom edge
     against the control as a search shortens it) or leftward where there is no room, and where
     neither side holds it whole it shrinks to the room below, else above. */
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

  .select__search .c-input {
    inline-size: 100%;
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

  /* Slots: the markup's custom properties place every row and heading, so layout never waits on
     the measurement, which only picks the rows that mount. */
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

  /* One line per row: a long label ends in an ellipsis, with its full text in the row's title. */
  .select__opt .select__value {
    flex: 1;
    white-space: nowrap;
    overflow-wrap: normal;
  }

  .select__opt .select__swatch {
    inline-size: 2.5rem;
    block-size: 0.875rem;
  }

  .select__opt--clear {
    border-block-end: 1px solid color-mix(in oklch, var(--color-border) 45%, transparent);
  }

  /* The cursor, from the keyboard or the pointer. */
  .select__opt--active {
    background: var(--color-row-hover);
    color: var(--color-text-1);
  }

  /* The selected value takes the maroon tint over the cursor's background; a keyboard cursor ring
     still draws on top of it. */
  .select__opt[aria-selected='true'] {
    background: var(--color-selected);
    color: var(--color-text-1);
    font-weight: 500;
  }

  /* The keyboard cursor alone gets a ring, inset, since real focus stays on the trigger. */
  .select__opt--cursor {
    outline: var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-width));
  }

  .select__opt--disabled {
    color: var(--color-text-3);
    cursor: not-allowed;
    opacity: 0.55;
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
      min-height: var(--spacing-touch-h);
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

    .select__swatch {
      forced-color-adjust: none;
    }
  }

  @container settings (max-width: 20rem) {
    .select__trigger {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>

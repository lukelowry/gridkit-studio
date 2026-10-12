<!-- @component
  Bindable combobox over a few options, each mounted, chosen from the keyboard or the pointer, with
  typeahead. Extra attributes go to the trigger.
-->
<script lang="ts" generics="T">
  import type { HTMLButtonAttributes } from 'svelte/elements'

  import { ListCursor } from './cursor.svelte.js'
  import Icon from './Icon.svelte'

  let {
    options,
    value = $bindable(null),
    label,
    disabled = false,
    ...rest
  }: Omit<HTMLButtonAttributes, 'children' | 'class' | 'value'> & {
    readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>
    value?: T | null
    /** The row label, and the start of the trigger's accessible name. */
    readonly label: string
    readonly disabled?: boolean
  } = $props()

  const id = $props.id()
  const anchorName = `--${id}`

  /** Opening sets it; any change to `disabled` closes the list. */
  let open = $derived.by(() => {
    void disabled
    return false
  })
  /** The last move came from the keyboard, so the active row draws a ring. */
  let keyboard = $state(false)

  let root = $state<HTMLElement>()
  let trigger = $state<HTMLButtonElement>()
  let popup = $state<HTMLElement>()

  const chosen = $derived(options.findIndex((option) => option.value === value))
  const cursor = new ListCursor({
    count: () => options.length,
    text: (at) => options[at]!.label.toLowerCase(),
  })
  const optionId = (at: number) => `${id}-o${at}`
  const activeId = $derived(open && cursor.active >= 0 ? optionId(cursor.active) : undefined)

  function show(): void {
    cursor.reset()
    keyboard = false
    cursor.active = Math.max(chosen, 0)
    open = true
  }

  function hide(returnFocus: boolean): void {
    open = false
    cursor.reset()
    if (returnFocus) trigger?.focus()
  }

  /** Keep focus on the trigger on presses in the open list or on it: pressing what takes no focus,
   *  or a button in macOS Safari or Firefox, would blur and close the list. */
  function holdFocus(event: MouseEvent): void {
    if (open) event.preventDefault()
  }

  function choose(at: number): void {
    value = options[at]!.value
    hide(true)
  }

  /** Move the cursor to the hovered row, and title a clipped label with its full text. */
  function point(at: number, element: HTMLElement): void {
    const text = element.querySelector('.select__value')
    element.title = text !== null && text.scrollWidth > text.clientWidth ? options[at]!.label : ''
    keyboard = false
    cursor.active = at
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
    switch (event.key) {
      case 'Enter':
      case ' ':
        event.preventDefault()
        if (cursor.active >= 0) choose(cursor.active)
        return
      case 'Escape':
        // Consumed, so enclosing handlers do not also act on it.
        event.preventDefault()
        event.stopPropagation()
        hide(true)
        return
      case 'Tab':
        hide(false)
        return
    }
    if (!cursor.key(event, options.length)) return
    event.preventDefault()
    keyboard = true
  }

  function leave(event: FocusEvent): void {
    if (open && !root?.contains(event.relatedTarget as Node | null)) hide(false)
  }

  $effect(() => {
    if (open && popup) popup.showPopover()
  })
</script>

<div class="select" bind:this={root} onfocusout={leave}>
  <button
    {...rest}
    type="button"
    role="combobox"
    class="c-row select__trigger"
    aria-labelledby={`${id}-label ${id}-value`}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={`${id}-list`}
    aria-activedescendant={activeId}
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
    <span id={`${id}-label`} class="c-row__label">{label}</span>
    <span class="select__control" style:anchor-name={anchorName}>
      <span id={`${id}-value`} class="select__value">{options[chosen]?.label ?? ''}</span>
      <span class="select__chev"><Icon name="chevron" /></span>
    </span>
  </button>

  {#if open}
    <div
      id={`${id}-popup`}
      class="select__popup"
      popover="auto"
      style:position-anchor={anchorName}
      bind:this={popup}
      ontoggle={(event) => {
        if (event.newState === 'closed' && open) hide(false)
      }}
    >
      <div
        id={`${id}-list`}
        class="select__list"
        role="listbox"
        tabindex="-1"
        aria-labelledby={`${id}-label`}
        onmousedown={holdFocus}
      >
        {#each options as option, at (at)}
          <!-- svelte-ignore a11y_click_events_have_key_events (the combobox's keydown handler chooses the active option) -->
          <div
            role="option"
            class={[
              'select__opt',
              at === cursor.active && 'select__opt--active',
              at === cursor.active && keyboard && 'select__opt--cursor',
            ]}
            id={optionId(at)}
            tabindex={-1}
            aria-selected={at === chosen}
            data-value={String(option.value)}
            onpointerenter={(event) => point(at, event.currentTarget)}
            onclick={() => choose(at)}
          >
            <span class="select__value">{option.label}</span>
            <span class="select__mark" aria-hidden="true">
              {#if at === chosen}<Icon name="check" />{/if}
            </span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

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

  .select__list {
    min-block-size: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
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

<!-- @component
  Titled row group with optional disclosure. Use level 3 beneath a panel heading.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLAttributes } from 'svelte/elements'

  import Icon from './Icon.svelte'

  let {
    label,
    meta = null,
    action,
    level = 2,
    collapsible = false,
    open = $bindable(true),
    children,
    class: className,
    ...rest
  }: Omit<HTMLAttributes<HTMLElement>, 'children'> & {
    /** The heading, and the region's accessible name. */
    readonly label: string
    /** A short readout at the right of the heading. */
    readonly meta?: string | null
    /** A control at the right of the heading. */
    readonly action?: Snippet
    /** The heading's rank. */
    readonly level?: 2 | 3
    /** Make the heading a disclosure button for the body. */
    readonly collapsible?: boolean
    /** Whether a collapsible body shows. */
    open?: boolean
    readonly children: Snippet
  } = $props()

  const id = $props.id()
</script>

<section {...rest} class={['section', className]} aria-labelledby={id}>
  <div class="section__head">
    <svelte:element this={level === 3 ? 'h3' : 'h2'} {id} class="section__title">
      {#if collapsible}
        <button
          type="button"
          class="section__toggle"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onclick={() => (open = !open)}
        >
          {label}
          <span class="section__chevron"><Icon name="chevron" /></span>
        </button>
      {:else}
        {label}
      {/if}
    </svelte:element>
    {#if meta}<span class="section__meta">{meta}</span>{/if}
    {#if action}
      <span class="section__action">{@render action()}</span>
    {/if}
  </div>
  {#if open || !collapsible}
    <div class="section__body" id={`${id}-body`}>{@render children()}</div>
  {/if}
</section>

<style>
  .section {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  /* Stacked sections keep a gap between one heading and the rows above it. The earlier section is
     another instance of this component, so it can only be matched globally. */
  :global(.section) + .section {
    margin-block-start: var(--spacing-lg);
  }

  .section__head {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    --section-control-size: 2rem;
    min-block-size: calc(
      var(--section-control-size) + var(--spacing-2xs) + var(--spacing-2xs) + 1px
    );
    padding: var(--spacing-2xs) var(--spacing-sm);
    border-bottom: 1px solid color-mix(in oklch, var(--color-border) 55%, transparent);
  }

  .section__title {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: var(--color-text-2);
    font-family: var(--font-body);
    font-size: var(--text-md);
    font-weight: 700;
    line-height: 1.2;
    white-space: normal;
    text-overflow: ellipsis;
  }

  .section__toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-sm);
    inline-size: 100%;
    min-block-size: var(--section-control-size);
    text-align: start;
    cursor: pointer;
  }

  .section__chevron {
    display: flex;
  }

  .section__toggle[aria-expanded='true'] .section__chevron {
    transform: rotate(180deg);
  }

  .section__meta {
    color: var(--color-text-3);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .section__action {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--spacing-2xs);
  }

  .section__body {
    min-inline-size: 0;
  }

  @media (pointer: coarse) {
    .section__head {
      --section-control-size: var(--spacing-touch-h);
    }
  }
</style>

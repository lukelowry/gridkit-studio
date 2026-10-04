<!-- @component
  Collapsible row group with bindable open state. Extra attributes target the disclosure button.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLButtonAttributes } from 'svelte/elements'

  import Icon from './Icon.svelte'

  let {
    label,
    summary = '',
    open = $bindable(false),
    children,
    class: className,
    ...rest
  }: Omit<HTMLButtonAttributes, 'children'> & {
    readonly label: string
    /** The readout beside the label, such as `Vm, Va` or `3 bindable`. */
    readonly summary?: string
    open?: boolean
    readonly children: Snippet
  } = $props()

  const body = $props.id()
</script>

<button
  {...rest}
  type="button"
  class={['c-row', 'accordion', className]}
  aria-expanded={open}
  aria-controls={body}
  onclick={() => (open = !open)}
>
  <span class="c-row__label">{label}</span>
  <span class="accordion__summary c-row__value">{summary}</span>
  <span aria-hidden="true" class="accordion__chevron">
    <Icon name="chevron" />
  </span>
</button>
{#if open}
  <div id={body} class="accordion__body" role="group" aria-label={label}>
    {@render children()}
  </div>
{/if}

<style>
  .accordion {
    grid-template-columns: minmax(0, 1fr) auto auto;
  }

  .accordion__summary {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .accordion__chevron {
    display: inline-flex;
    inline-size: 1rem;
    block-size: 1rem;
    color: var(--color-text-3);
    transition: transform var(--motion-fast) var(--motion-hover);
  }

  .accordion[aria-expanded='true'] .accordion__chevron {
    transform: rotate(180deg);
  }

  .accordion__body :global(.c-row) {
    padding-inline-start: var(--spacing-lg);
  }
</style>

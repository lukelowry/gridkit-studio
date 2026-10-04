<!-- @component
  Titled row group. From Lattice.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    label,
    children,
  }: {
    /** The heading, and the region's accessible name. */
    readonly label: string
    readonly children: Snippet
  } = $props()

  const id = $props.id()
</script>

<section class="section" aria-labelledby={id}>
  <div class="section__head">
    <h2 {id} class="section__title">{label}</h2>
  </div>
  <div class="section__body">{@render children()}</div>
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
    margin-block-start: var(--spacing-md);
  }

  .section__head {
    display: flex;
    align-items: center;
    min-block-size: var(--spacing-header-h);
    padding: var(--spacing-2xs) var(--spacing-sm);
    border-bottom: 1px solid color-mix(in oklch, var(--color-border) 55%, transparent);
  }

  .section__title {
    flex: 1;
    min-width: 0;
    color: var(--color-text-2);
    font-size: var(--text-md);
    font-weight: 700;
    line-height: 1.2;
  }

  .section__body {
    min-inline-size: 0;
  }
</style>

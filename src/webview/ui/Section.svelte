<!-- @component
  A titled group of rows.
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
  <h2 {id} class="section__title">{label}</h2>
  <div class="section__body">{@render children()}</div>
</section>

<style>
  .section {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  /* The previous section is another instance, so it matches only globally. */
  :global(.section) + .section {
    margin-block-start: var(--spacing-lg);
  }

  .section__title {
    display: flex;
    align-items: center;
    min-block-size: calc(2rem + var(--spacing-2xs) + var(--spacing-2xs) + 1px);
    margin: 0;
    padding: var(--spacing-2xs) var(--spacing-sm);
    overflow: hidden;
    border-bottom: 1px solid color-mix(in oklch, var(--color-border) 55%, transparent);
    color: var(--color-text-2);
    font-family: var(--font-body);
    font-size: var(--text-md);
    font-weight: 700;
    line-height: 1.2;
    text-overflow: ellipsis;
  }

  .section__body {
    min-inline-size: 0;
  }

  @media (pointer: coarse) {
    .section__title {
      min-block-size: calc(var(--spacing-touch-h) + var(--spacing-2xs) + var(--spacing-2xs) + 1px);
    }
  }
</style>

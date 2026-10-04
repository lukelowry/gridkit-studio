<!-- @component
  One glyph from the table in glyphs.ts, in the current text color. Hidden from assistive
  technology: the control holding it carries the accessible name.
-->
<script lang="ts">
  import { GLYPHS, type IconName } from './glyphs.js'

  let { name }: { readonly name: IconName } = $props()
</script>

<svg
  width="16"
  height="16"
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#each GLYPHS[name] as shape, index (index)}
    {#if typeof shape === 'string'}
      <path d={shape} />
    {:else}
      {@const [cx, cy, r] = shape}
      <circle {cx} {cy} {r} />
    {/if}
  {/each}
</svg>

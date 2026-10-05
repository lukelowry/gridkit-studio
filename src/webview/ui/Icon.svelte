<!-- @component
  A glyph from glyphs.ts in the current text color.
-->
<script lang="ts">
  import { icon, type IconName } from './glyphs.js'

  let { name }: { readonly name: IconName } = $props()
</script>

{@html icon(name)}

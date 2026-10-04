<!-- @component
  Label/control row. Pass the supplied label ID to the child control for its accessible name. From
  Lattice.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    label,
    children,
  }: {
    readonly label: string
    /** The control or readout on the right, given the label's id. */
    readonly children: Snippet<[labelId: string]>
  } = $props()

  const id = $props.id()
</script>

<div class="c-row c-setting-row">
  <span {id} class="c-row__label">{label}</span>
  {@render children(id)}
</div>

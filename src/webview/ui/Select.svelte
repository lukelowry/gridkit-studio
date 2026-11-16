<!-- @component A labeled select row. Extra attributes go to the select. -->
<script lang="ts" generics="T">
  import type { HTMLSelectAttributes } from 'svelte/elements'

  let {
    options,
    value = $bindable(null),
    label,
    disabled = false,
    ...rest
  }: Omit<HTMLSelectAttributes, 'children' | 'class' | 'value'> & {
    readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>
    value?: T | null
    /** The row's label, also the select's accessible name. */
    readonly label: string
    readonly disabled?: boolean
  } = $props()

  const id = $props.id()
</script>

<div class="c-row select">
  <label class="c-row__label" for={id}>{label}</label>
  <select {...rest} {id} {disabled} bind:value>
    {#each options as option (option.value)}
      <option value={option.value}>{option.label}</option>
    {/each}
  </select>
</div>

<style>
  /* A form sets --row-label so its controls line up. */
  .select {
    grid-template-columns: var(--row-label, auto) minmax(8ch, 1fr);
  }

  /* Sized like VS Code's dropdowns. */
  select {
    min-inline-size: 0;
    min-block-size: 24px;
    padding: var(--spacing-2xs) var(--spacing-xs);
    border: 1px solid var(--vscode-dropdown-border, transparent);
    border-radius: var(--radius-sm);
    background: var(--vscode-dropdown-background, var(--color-surface-2));
    color: var(--vscode-dropdown-foreground, var(--color-text-1));
    font-family: var(--font-body);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  select:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }
</style>

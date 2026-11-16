<!-- @component A labeled number row. It reports a value when the user commits it, by Enter or by
leaving the field, and empties to undefined. -->
<script lang="ts">
  let {
    label,
    value,
    unit,
    placeholder,
    min,
    max,
    step = 'any',
    disabled = false,
    onchange,
  }: {
    /** The row's label, also the input's accessible name. */
    readonly label: string
    readonly value: number | undefined
    readonly unit?: string
    /** Shown while empty, as the value that applies then. */
    readonly placeholder?: string
    readonly min?: number
    readonly max?: number
    readonly step?: number | 'any'
    readonly disabled?: boolean
    readonly onchange: (value: number | undefined) => void
  } = $props()

  const id = $props.id()
</script>

<div class="c-row number">
  <label class="c-row__label" for={id}>{label}</label>
  <span class="number__control">
    <input
      {id}
      type="number"
      {min}
      {max}
      {step}
      {disabled}
      {placeholder}
      value={value ?? ''}
      onchange={(event) => {
        const input = event.currentTarget
        const next = input.value.trim() === '' ? undefined : input.valueAsNumber
        onchange(next === undefined || Number.isFinite(next) ? next : undefined)
        // A value the owner does not take shows the current one again.
        input.value = value === undefined ? '' : String(value)
      }}
    />
    {#if unit}<span class="number__unit" aria-hidden="true">{unit}</span>{/if}
  </span>
</div>

<style>
  /* A form sets --row-label so its controls line up. */
  .number {
    grid-template-columns: var(--row-label, auto) minmax(8ch, 1fr);
  }

  .number__control {
    display: flex;
    align-items: center;
    gap: var(--spacing-xs);
    min-inline-size: 0;
  }

  /* Sized and colored like VS Code's inputs. */
  input {
    inline-size: 100%;
    min-inline-size: 0;
    min-block-size: 24px;
    padding: var(--spacing-2xs) var(--spacing-xs);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: var(--radius-sm);
    background: var(--vscode-input-background, var(--color-surface-2));
    color: var(--vscode-input-foreground, var(--color-text-1));
    font-family: var(--font-body);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    text-align: end;
  }

  input::placeholder {
    color: var(--vscode-input-placeholderForeground, var(--color-text-2));
  }

  input:focus-visible {
    outline-offset: -1px;
  }

  input:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .number__unit {
    min-inline-size: 3ch;
    color: var(--color-text-2);
    font-size: var(--text-sm);
  }
</style>

<!-- A parameter's text field or dropdown, with its unit and validation note. -->
<script lang="ts">
  import Select from '../ui/Select.svelte'
  import type { Row } from './rows.js'

  let {
    row,
    value,
    error,
    disabled = false,
    compact = false,
    onvalue,
  }: {
    row: Row
    /** The field's text; empty shows a dropdown's placeholder. */
    value: string
    error?: string
    disabled?: boolean
    /** A dropdown without a label beside it, which names itself until a pick. */
    compact?: boolean
    /** Each keystroke or pick; a cleared dropdown gives ''. */
    onvalue: (text: string) => void
  } = $props()

  const control = $derived(`field-${row.key}`)
  const note = $derived(error ? `${control}-error` : undefined)
  /** The input's accessible name: the label, then its unit in parentheses. */
  const spoken = $derived(row.unit === '' ? row.label : `${row.label} (${row.unit})`)
</script>

{#if row.control === 'select'}
  <Select
    label={row.label}
    hideLabel={compact}
    {compact}
    options={row.choices}
    placeholder={compact ? row.label : row.required ? 'None' : 'Default'}
    clearable={!row.required}
    {disabled}
    aria-required={row.required || undefined}
    aria-invalid={error ? true : undefined}
    aria-describedby={note}
    data-testid={control}
    bind:value={() => (value === '' ? null : value), (picked) => onvalue(picked ?? '')}
  />
{:else}
  <label class="c-row c-setting-row entry" title={row.description}>
    <span class="c-row__label">
      {row.label}{#if row.unit}<span class="entry__unit">
          ({row.unit})
        </span>{/if}{#if row.required}<span class="c-required" aria-hidden="true">*</span>{/if}
    </span>
    <input
      id={control}
      class="c-input field-input"
      type="text"
      spellcheck="false"
      inputmode={row.inputmode}
      required={row.required}
      {disabled}
      {value}
      aria-label={spoken}
      aria-invalid={Boolean(error)}
      aria-describedby={note}
      data-testid={control}
      oninput={(event) => onvalue(event.currentTarget.value)}
    />
  </label>
{/if}
{#if error}
  <p class="c-note c-note--error" id={note} role="alert">{error}</p>
{/if}

<style>
  /* The whole row is the input's label, so a click anywhere on it focuses the input. */
  .entry {
    cursor: text;
  }

  .entry__unit {
    margin-inline-start: 0.25em;
    color: var(--color-text-2);
    font-weight: 400;
  }

  /* One width for every number, in tabular digits. */
  .field-input {
    inline-size: 9ch;
    font-variant-numeric: tabular-nums;
    text-align: end;
  }

  .field-input[aria-invalid='true'] {
    border-color: var(--color-error-text);
  }

  /* A narrow panel gives the field its column's full width. */
  @container settings (max-width: 24rem) {
    .field-input {
      inline-size: 100%;
    }
  }
</style>

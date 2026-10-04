<!-- Labeled DynamicSimulation form control with units and validation feedback. -->
<script lang="ts">
  import Select from '../ui/Select.svelte'
  import type { Row } from './rows.js'

  let {
    row,
    value,
    error,
    disabled = false,
    onvalue,
  }: {
    row: Row
    /** The field's text; a dropdown shows its placeholder while it is empty. */
    value: string
    /** What is wrong with the value; no note without it. */
    error?: string
    disabled?: boolean
    /** Every edit: each keystroke, or a pick (empty for the clear row). */
    onvalue: (text: string) => void
  } = $props()

  const control = $derived(`field-${row.key}`)
  const note = $derived(error ? `${control}-error` : undefined)
  /** The text field's name for assistive technology: the label, then its unit in parentheses. */
  const spoken = $derived(row.unit === '' ? row.label : `${row.label} (${row.unit})`)
</script>

{#if row.control === 'select'}
  <Select
    label={row.label}
    options={row.choices}
    placeholder={row.placeholder || (row.required ? 'None' : 'Default')}
    clearable={!row.required}
    {disabled}
    aria-required={row.required || undefined}
    aria-invalid={error ? true : undefined}
    aria-describedby={note}
    data-testid={control}
    bind:value={() => (value === '' ? null : value), (picked) => onvalue(picked ?? '')}
  />
{:else}
  <label
    class={['c-row', 'c-setting-row', 'entry', row.stack && 'c-row--stack']}
    title={row.description}
  >
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
      placeholder={row.placeholder}
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
  /* The row is the input's label, so a press anywhere on it lands in the input. */
  .entry {
    cursor: text;
  }

  .entry__unit {
    margin-inline-start: 0.25em;
    color: var(--color-text-3);
    font-weight: 400;
  }

  .field-input {
    inline-size: var(--field-input-w, 9ch);
    font-variant-numeric: tabular-nums;
    text-align: end;
  }

  .entry.c-row--stack .field-input {
    inline-size: 100%;
    text-align: start;
  }

  .field-input[aria-invalid='true'] {
    border-color: var(--color-error-text);
  }

  /* Once a narrow panel stacks the settings rows, the field takes the full width. */
  @container settings (max-width: 24rem) {
    .field-input {
      inline-size: 100%;
    }
  }
</style>

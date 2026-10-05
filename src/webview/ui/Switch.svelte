<!-- @component
  Bindable switch row with an On/Off readout. Extra attributes go to the button.
-->
<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements'

  let {
    label,
    checked = $bindable(false),
    ...rest
  }: Omit<HTMLButtonAttributes, 'children' | 'class'> & {
    /** The setting's name, shown left and used as the accessible name. */
    readonly label: string
    checked?: boolean
  } = $props()
</script>

<button
  {...rest}
  type="button"
  role="switch"
  class="c-row switch"
  aria-checked={checked}
  onclick={() => (checked = !checked)}
>
  <span class="c-row__label">{label}</span>
  <span class="switch__state" aria-hidden="true">
    <span class="switch__track"><span class="switch__knob"></span></span>
    <span class="c-row__value">{checked ? 'On' : 'Off'}</span>
  </span>
</button>

<style>
  .switch__state {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-sm);
  }

  .switch__state .c-row__value {
    min-inline-size: 3ch;
  }

  /* Off reads in the caption color. */
  .switch[aria-checked='false'] .c-row__value {
    color: var(--color-text-2);
  }

  .switch__track {
    display: inline-flex;
    align-items: center;
    inline-size: 1.75rem;
    block-size: 1rem;
    padding: 2px;
    border: 1px solid var(--color-text-2);
    border-radius: var(--radius-pill);
    background: var(--color-surface-2);
  }

  .switch__knob {
    inline-size: 0.625rem;
    block-size: 0.625rem;
    border-radius: 50%;
    background: var(--color-text-2);
  }

  .switch[aria-checked='true'] .switch__track {
    justify-content: flex-end;
    border-color: var(--color-primary);
    background: var(--color-primary);
  }

  .switch[aria-checked='true'] .switch__knob {
    background: var(--color-on-primary);
  }

  @media (forced-colors: active) {
    .switch[aria-checked='true'] .switch__track {
      background: Highlight;
    }

    .switch[aria-checked='true'] .switch__knob {
      background: HighlightText;
    }
  }
</style>

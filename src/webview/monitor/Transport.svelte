<!-- Accessible playback controls. Size time readouts from the full span to prevent layout shifts. From Lattice. -->
<script lang="ts">
  import type { Axis, Domain } from '@latkit/model'

  import type { ClockState, LoopMode } from '../../transport.js'
  import type { Clock } from '../clock.js'
  import { formatNumber } from '../format.js'
  import type { IconName } from '../ui/glyphs.js'
  import Icon from '../ui/Icon.svelte'
  import Select from '../ui/Select.svelte'
  import { axisName } from './plot.js'

  let {
    clock,
    tick,
    t,
    live,
    frames,
    recorded,
    axis,
  }: {
    /** The case's clock, which the controls change. */
    clock: Clock
    /** The clock as of its last change, and the playhead now. */
    tick: ClockState
    t: number
    /** Whether the run on show is still receiving frames. */
    live: boolean
    /** Frames recorded so far. */
    frames: number
    /** The times those frames cover, which bound a step. */
    recorded: Domain
    axis?: Axis
  } = $props()

  /** The speeds always offered, in simulated seconds per second. */
  const SPEEDS = [0.5, 1, 2, 4]
  /** The two frame steps: which way each moves, and its tooltip, which names the key that does the
   *  same on the playback controls. */
  const STEPS = {
    back: { direction: -1, hint: 'Previous frame (Left arrow on playback controls)' },
    forward: { direction: 1, hint: 'Next frame (Right arrow on playback controls)' },
  } as const
  /** The repeat modes in the order the control steps through them, each with its name and symbol. */
  const REPEATS: readonly { readonly mode: LoopMode; readonly label: string; glyph: IconName }[] = [
    { mode: 'none', label: 'Once', glyph: 'play-once' },
    { mode: 'wrap', label: 'Loop', glyph: 'repeat' },
    { mode: 'pingpong', label: 'Bounce', glyph: 'bounce' },
  ]

  const playing = $derived(tick.status === 'playing')
  const playable = $derived(frames > 1 && tick.span[1] > tick.span[0])
  const finished = $derived(!live && !playing && tick.loop === 'none' && t >= tick.span[1])
  const verb = $derived(playing ? 'Pause' : finished ? 'Replay' : 'Play')
  const glyph = $derived<IconName>(playing ? 'pause' : finished ? 'replay' : 'play')
  const repeat = $derived(
    Math.max(
      0,
      REPEATS.findIndex(({ mode }) => mode === tick.loop),
    ),
  )
  /** The repeat mode a press moves to. */
  const following = $derived(REPEATS[(repeat + 1) % REPEATS.length]!)
  // A speed set elsewhere is offered after the usual ones, so the control can show it.
  const speeds = $derived(
    (SPEEDS.includes(tick.rate) ? SPEEDS : [...SPEEDS, tick.rate]).map((rate) => ({
      value: rate,
      label: `${formatNumber(rate)}×`,
    })),
  )
  /** Whether a frame lies behind the playhead, and ahead of it, to step to. */
  const earlier = $derived(frames >= 2 && t > recorded[0])
  const later = $derived(frames >= 2 && t < recorded[1])

  const name = $derived(axisName(axis))
  const unit = $derived(axis?.unit ? ' ' + axis.unit : '')
  const start = $derived(tick.span[0].toFixed(2))
  const end = $derived(tick.span[1].toFixed(2))
  /** Room for the widest time the span can show, in digits. */
  const digits = $derived(Math.max(start.length, end.length))

  const step = (direction: 1 | -1) => clock.act({ action: 'step', value: direction })

  function seekKey(event: KeyboardEvent): void {
    if (!playable || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (!(event.target instanceof HTMLElement) || !event.target.closest('.playback__buttons'))
      return
    const actions: Record<string, () => void> = {
      ArrowLeft: () => step(-1),
      ArrowDown: () => step(-1),
      ArrowRight: () => step(1),
      ArrowUp: () => step(1),
      Home: () => clock.seek(recorded[0]),
      End: () => clock.seek(recorded[1]),
    }
    const action = actions[event.key]
    if (action) {
      event.preventDefault()
      action()
    }
  }
</script>

{#snippet stepper(way: keyof typeof STEPS, open: boolean)}
  <button
    type="button"
    class="c-icon-btn"
    title={STEPS[way].hint}
    aria-label={`Step ${way} one frame`}
    disabled={!open}
    data-testid={`transport-step-${way}`}
    onclick={() => step(STEPS[way].direction)}
  >
    <Icon name={`step-${way}`} />
  </button>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="playback"
  role="group"
  aria-label="Playback"
  data-testid="transport"
  onkeydown={seekKey}
>
  <div class="playback__position">
    <div class="playback__buttons">
      {@render stepper('back', earlier)}
      <button
        type="button"
        class="c-icon-btn"
        title={verb}
        aria-label={verb}
        aria-keyshortcuts="ArrowLeft ArrowRight Home End"
        disabled={!playing && !playable}
        data-testid="transport-play"
        onclick={() => clock.act({ action: 'playPause' })}
      >
        <Icon name={glyph} />
      </button>
      {@render stepper('forward', later)}
    </div>
    <span
      class="playback__clock"
      title={`${name} ${t}${unit}; range ${tick.span[0]}–${tick.span[1]}${unit}`}
    >
      <span class="playback__caption">{name}</span>
      <span
        class="playback__time"
        style:--clock-width={`${digits + end.length + unit.length + 3}ch`}
        data-testid="transport-time"
      >
        <span class="playback__now" style:inline-size={`${digits}ch`}>{t.toFixed(2)}</span>
        <span class="playback__end">{`/ ${end}${unit}`}</span>
      </span>
    </span>
  </div>
  <div class="playback__settings" role="group" aria-label="Playback settings">
    <Select
      label="Speed"
      hideLabel
      options={speeds}
      compact
      disabled={!playable}
      data-testid="transport-rate"
      bind:value={
        () => tick.rate,
        (rate) => {
          if (rate !== null) clock.act({ action: 'rate', value: rate })
        }
      }
    />
    <button
      type="button"
      class="c-icon-btn"
      title={`Repeat: ${REPEATS[repeat]!.label} (press for ${following.label})`}
      aria-label={`Repeat: ${REPEATS[repeat]!.label}`}
      disabled={!playable}
      data-testid="transport-loop"
      onclick={() => clock.act({ action: 'loop', value: following.mode })}
    >
      <Icon name={REPEATS[repeat]!.glyph} />
    </button>
  </div>
</div>

<style>
  /* One row: the run's name yields space before the controls do. */
  .playback {
    display: flex;
    flex-wrap: nowrap;
    justify-content: safe flex-end;
    align-items: center;
    gap: var(--spacing-sm);
    min-inline-size: 0;
  }

  /* Controls side by side sit as a panel header's actions do. */
  .playback__position,
  .playback__buttons,
  .playback__settings {
    display: flex;
    align-items: center;
    gap: var(--spacing-2xs);
    min-inline-size: 0;
  }

  .playback__position {
    flex-wrap: nowrap;
    gap: var(--spacing-sm);
    flex-shrink: 0;
  }

  .playback__settings {
    flex: 0 0 auto;
    flex-wrap: nowrap;
  }

  /* An unlabeled trigger takes its row's width, but this group takes its content's, so the trigger
     hugs its value instead of collapsing. */
  .playback__settings :global(.select__trigger.select__trigger--unlabeled) {
    inline-size: auto;
  }

  /* The time: a caption, then the playhead over the span's end in fixed-width digits. */
  .playback__clock {
    display: inline-flex;
    flex-wrap: nowrap;
    align-items: baseline;
    gap: var(--spacing-sm);
    min-inline-size: 0;
  }

  .playback__caption {
    color: var(--color-text-2);
    font-size: var(--text-sm);
  }

  /* The two readouts stand a digit apart however the markup is spaced. */
  .playback__time {
    display: inline-flex;
    gap: 1ch;
    inline-size: var(--clock-width);
    flex: 0 0 auto;
    color: var(--color-text-1);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .playback__now {
    display: inline-block;
    text-align: end;
  }

  .playback__end {
    color: var(--color-text-2);
  }

  @container monitor (max-width: 52rem) {
    .playback__caption {
      display: none;
    }
  }

  @container monitor (max-width: 40rem) {
    .playback {
      gap: var(--spacing-xs);
    }

    .playback__end {
      display: none;
    }

    .playback__time {
      inline-size: auto;
    }
  }
</style>

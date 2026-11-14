<!-- The Network: the case on a latkit canvas, its projections and rotation over its top right. The
  rows a revision of the case draws and the GPU's view of them have lifetimes of their own: the
  view goes while the page is out of sight, and is made again where it looked. -->
<script lang="ts">
  import type { Camera, Data, Scene, Source } from 'latkit'
  import { onMount, tick } from 'svelte'

  import { type Entity, isEntity } from '../../shared/document.js'
  import type { Mappings } from '../../shared/mappings.js'
  import { revisionOf, type Summary, type ViewState } from '../../shared/messages.js'
  import { reader, TILTED } from '../../shared/settings.js'
  import { bridge } from '../bridge.js'
  import { createClock } from '../clock.js'
  import { saveImage, viewShot } from '../export/image.js'
  import { type CanvasView, followPlayback } from '../latkit/canvas.js'
  import { CaseProjection } from '../latkit/data.js'
  import { FrameReads, PlayheadFeed, SHOWN_PER_SECOND } from '../latkit/frames.js'
  import { bindInteractions } from '../latkit/interactions.js'
  import LatkitCanvas from '../latkit/LatkitCanvas.svelte'
  import { type Background, mapKey, mapOf, NO_MAP } from '../latkit/maps.js'
  import { LatkitPage } from '../latkit/page.svelte.js'
  import { caseFit, daylightOf, sampledFields, sceneFields, sceneOf } from '../latkit/scenes.js'
  import { nativeTheme } from '../latkit/theme.js'
  import { nativeMenu } from '../menu.js'
  import Icon from '../ui/Icon.svelte'

  /** The ways the Network looks at a case, as its toolbar names them. */
  const LOOKS = [
    ['Flat', 'projection-flat'],
    ['Tilt', 'projection-tilt'],
    ['Globe', 'projection-globe'],
  ] as const
  type Look = (typeof LOOKS)[number][0]

  /** The rows of one revision of the case, as the view draws them. */
  interface Drawn {
    readonly data: Data
    readonly summary: Summary
    /** The fields of each type the rows hold. */
    readonly fields: ReadonlyMap<string, ReadonlySet<string>>
  }

  /** Where a view of the case at `uri` looked: what the page keeps to open on again. */
  interface Looked {
    readonly uri?: string
    readonly camera?: Camera
  }

  const mark = (name: string) => {
    if (!performance.getEntriesByName(name).length) performance.mark(name)
  }
  mark('canvas:boot')

  /** Elements as one key, by their type and id alone. */
  const keyOf = (entities: readonly Entity[]) =>
    JSON.stringify(entities.map(({ table, id }) => [table, id]))

  /** latkit replaces a lost device itself; only once it stops does the page start over. A wait the
   *  view let go of, as it went, is no failure. */
  const page = new LatkitPage((error) => {
    busy = false
    bridge.report(error, { view: 'network', phase: 'draw' })
  })
  const fail = page.fail
  const cases = new CaseProjection()
  const reads = new FrameReads()
  /** The frames each mapped field of the results holds about the playhead. */
  const feed = new PlayheadFeed(reads)
  /** Lets go of an image being drawn once the page goes. */
  const lifetime = new AbortController()

  let app = $state.raw<ViewState>({})
  let drawn = $state.raw<Drawn>()
  /** The view on show, while the page is in sight. */
  let shown = $state.raw<CanvasView>()
  let background = $state.raw<Background>(NO_MAP)
  /** Until the case first draws, or cannot. */
  let busy = $state(true)
  /** Counts the changes to the frames the mapped fields hold. */
  let framesVersion = $state(0)
  /** Where the view that went last looked, until the next is made. */
  let left = $state.raw<Looked>()

  let closed = false
  let playback: (() => void) | undefined
  let saving: ReturnType<typeof setTimeout> | undefined
  /** The selection the view shows, and the one last made here, as keys. */
  let selected = ''
  let own = ''
  let madeMap = ''
  let mapController: AbortController | undefined
  let received = 0
  /** The mappings last drawn, which stay until the rows hold the fields of those sent since. */
  let held: Mappings = {}

  const active = $derived(page.active)
  const settings = $derived(reader(app.settings))
  const geographic = $derived(!!drawn?.summary.definition.drawing.geographic)
  const tilt = $derived(settings.get('network.tilt'))
  const look = $derived<Look>(
    geographic && settings.get('network.projection') === 'globe'
      ? 'Globe'
      : tilt > 0
        ? 'Tilt'
        : 'Flat',
  )
  /** The sun's time, read once each time the Daylight setting turns on: a scene that differed on
   *  every rebuild would be drawn anew on every rebuild. */
  const lit = $derived(settings.get('network.map.daylight'))
  const daylight = $derived(daylightOf(lit))
  /** What the view draws now: the mappings whose fields its rows hold. */
  const mappings = $derived.by(() => {
    if (!drawn) return held
    const { fields } = drawn
    const asked = sceneFields(drawn.summary.definition, app.mappings)
    if (asked.every((type) => type.fields.every((name) => fields.get(type.table)?.has(name))))
      held = app.mappings ?? {}
    return held
  })
  const scene = $derived.by((): Scene | undefined => {
    void page.themeVersion
    void framesVersion
    return (
      drawn &&
      sceneOf(drawn.data, drawn.summary.definition, settings, nativeTheme(settings, 'network'), {
        mappings,
        results: app.results,
        sampled: feed.source,
        background,
        daylight,
      })
    )
  })
  const sources = $derived.by((): Source[] => {
    void framesVersion
    return drawn ? [drawn.data, ...background.sources, ...feed.sources] : []
  })
  /** Where a view made now looks first: where the last one looked, else where the page last kept
   *  one of this case looking; with neither, it frames the whole case. */
  const camera = $derived.by(() => {
    const looked = left ?? bridge.state<Looked>({})
    return looked.uri === app.uri ? looked.camera : undefined
  })

  /** Whether every sampled field mapped holds the frames at `at`. */
  function covered(at: number): boolean {
    if (!drawn || !app.results?.frames) return true
    return feed.holds(sampledFields(drawn.summary.definition, app.mappings, app.results), at)
  }

  /** Keeps the frames each mapped field shows about `at`, as the clock moves, and lets go of those
   *  of fields no longer mapped. */
  function prefetch(at: number) {
    if (!active || !drawn) return
    const results = app.results
    const fields = results?.frames
      ? sampledFields(drawn.summary.definition, app.mappings, results)
      : []
    if (results?.frames)
      void feed
        .ahead(fields, at, {
          results,
          playing: clock.state.status === 'playing',
          rate: clock.state.rate,
          shown: SHOWN_PER_SECOND,
          bytes: 8 * 1024 * 1024,
        })
        .then((changed) => {
          if (changed && !closed) framesVersion++
        }, fail)
    if (feed.keep(fields)) framesVersion++
  }

  const clock = createClock((at) => {
    prefetch(at)
    if (shown && active && covered(at)) shown.view.at = at
  }, follow)

  /** Shows the playhead on every frame while it plays. */
  function follow() {
    playback?.()
    playback = undefined
    const view = shown?.view
    if (!page.gpu || !view || !active || clock.state.status !== 'playing') return
    playback = followPlayback(
      page.gpu,
      () => (covered(clock.now()) ? [view] : []),
      () => {
        const at = clock.now()
        prefetch(at)
        return at
      },
    )
  }

  /** Says what the canvas frames once its camera and size rest: the page keeps the camera to open
   *  on again, and the extension the framing, for an export to frame what the user saw. A canvas
   *  out of sight frames nothing. */
  function framing() {
    clearTimeout(saving)
    saving = setTimeout(() => {
      if (!shown) return
      const { view, canvas } = shown
      const size = [canvas.clientWidth, canvas.clientHeight]
      if (!size[0] || !size[1]) return
      const { camera } = view
      bridge.save({ uri: app.uri, camera } satisfies Looked)
      bridge.send({ kind: 'framing', framing: { camera, size } })
    }, 200)
  }

  /** Takes up the view made: frames the whole case unless it opened where one looked before, and
   *  hears what the user does in it. As it goes, where it looked is kept for the next. */
  function ready(made: CanvasView) {
    const { view, canvas } = made
    const uri = app.uri
    if (!camera && drawn) made.fit(caseFit(drawn.data, drawn.summary.definition.drawing))
    left = undefined
    selected = ''
    shown = made
    const stop = bindInteractions(view, canvas, {
      select(element) {
        own = keyOf(element ? [element] : [])
        bridge.send({ kind: 'select', element })
      },
      open: (element) => bridge.send({ kind: 'open', element }),
      menu: (point, elements) => nativeMenu(canvas, point, elements, app, 'network'),
      camera: framing,
      error: fail,
    })
    // What it frames is said once its first fit applies: till then it shows only its background.
    const resizing = new ResizeObserver(framing)
    void made.framed().then(() => {
      if (shown === made) resizing.observe(canvas)
    })
    return () => {
      left = { uri, camera: view.camera }
      stop()
      resizing.disconnect()
      clearTimeout(saving)
      if (shown === made) shown = undefined
    }
  }

  function drew() {
    mark('canvas:frame')
    busy = false
  }

  /** The map the settings choose under a case on the earth, made anew once they or the theme
   *  change what it draws. */
  async function backgrounds() {
    const key = mapKey(settings, geographic)
    if (madeMap === key) return
    madeMap = key
    mapController?.abort()
    const controller = (mapController = new AbortController())
    try {
      const next = await mapOf(settings, geographic, controller.signal)
      if (controller.signal.aborted || closed) {
        next.destroy?.()
        return
      }
      const old = background
      background = next
      // The view draws the new map before the old one's rows go.
      await tick()
      old.destroy?.()
    } catch (error) {
      if (!controller.signal.aborted) {
        madeMap = ''
        fail(error)
      }
    }
  }

  $effect(() => {
    void page.themeVersion
    void backgrounds()
  })
  $effect(() => {
    if (shown) shown.view.orbit = settings.get('network.orbit')
  })
  // A pitch alone turns the camera and keeps a fit that is due.
  $effect(() => {
    if (shown) shown.view.camera = { pitch: tilt }
  })
  $effect(() => {
    void framesVersion
    void drawn
    if (shown && covered(clock.now())) shown.view.at = clock.now()
  })
  /** The selection as the Network shows it, framed unless the user picked it here. */
  $effect(() => {
    if (!shown || !drawn) return
    const data = drawn.data.name
    const entities = app.networkSelection ?? []
    const key = keyOf(entities)
    if (key === selected) return
    selected = key
    shown.view.selection = entities.map((entity) => ({
      data,
      table: entity.table,
      ids: [entity.id],
    }))
    if (entities[0] && key !== own) shown.fit({ reveal: { data, ...entities[0] } })
  })
  $effect(() => {
    void shown
    void page.gpu
    void active
    follow()
  })

  onMount(() => {
    const off = bridge.on((message) => {
      if (message.kind === 'state') {
        const previous = app
        app = message.state
        if (previous.uri !== app.uri) {
          drawn = undefined
          cases.clear()
        }
        if (previous.uri !== app.uri || previous.results?.id !== app.results?.id) {
          feed.clear()
          reads.clear()
          framesVersion++
        }
        const next = app.summary
        if (next && !app.stale) {
          const fields = sceneFields(next.definition, app.mappings)
          void cases
            .receive({ revision: revisionOf(next), fields }, fields)
            .then((changed) => {
              if (!changed || closed) return
              drawn = {
                data: cases.slot.current!.data,
                summary: next,
                fields: new Map(fields.map((type) => [type.table, new Set(type.fields)])),
              }
              received++
              mark('canvas:data')
            })
            .catch(fail)
        }
        prefetch(clock.now())
        if (!app.summary && app.error) busy = false
      } else if (message.kind === 'action') {
        if (message.command === 'reloadView') void page.open()
        else if (message.command === 'fit' && shown && drawn)
          shown.fit(caseFit(drawn.data, drawn.summary.definition.drawing))
        else if (message.command === 'neighborhood' && shown && drawn) {
          // What the Network draws for the element in context, and what each of those links to.
          const { view } = shown
          const data = drawn.data.name
          const entities = Array.isArray(message.value) ? message.value.filter(isEntity) : []
          if (entities.length)
            shown.fit({
              rows: entities.flatMap((entity) => [
                { data, table: entity.table, ids: [entity.id] },
                ...view.neighbors({ data, ...entity }),
              ]),
            })
        } else if (message.command === 'exportImage' && shown && drawn && app.uri) {
          const [made, uri, name] = [shown, app.uri, drawn.summary.name]
          // The picture shows the view as framed, never its background before its first fit.
          void made
            .framed()
            .then(() => saveImage(viewShot(made.view), uri, name, 'network', lifetime.signal))
            .catch(fail)
        }
      }
    })
    const hooks = window as Window & {
      gridkitLifecycle?: () => unknown
      gridkitStats?: () => unknown
      gridkitSelection?: () => unknown
      gridkitLocate?: (entity: Entity) => unknown
      gridkitLose?: () => void
    }
    hooks.gridkitLifecycle = () => ({
      visible: page.visible,
      hidden: document.hidden,
      summary: drawn?.summary.version,
      projection: cases.slot.current?.key,
      view: !!shown,
      gpu: !!page.gpu,
    })
    hooks.gridkitStats = () => {
      const gpu = page.gpu
      if (!shown || !gpu) return undefined
      const { view } = shown
      return {
        ...view.stats,
        complete: view.complete,
        waiting: view.waiting,
        space: view.scene.space,
        work: gpu.work,
        resident: gpu.resident,
        uploading: gpu.uploading,
        lost: gpu.lost,
        at: view.at,
        requestedAt: clock.now(),
        covered: covered(clock.now()),
        windows: feed.spans,
        received,
        mappings: held,
        cacheBytes: reads.bytes,
        reads: reads.active,
      }
    }
    hooks.gridkitSelection = () =>
      shown && {
        entities: shown.view.selection.flatMap((group) =>
          group.ids.map((id) => ({ table: group.table, id })),
        ),
        camera: shown.view.camera,
      }
    hooks.gridkitLocate = (entity) =>
      shown && drawn
        ? shown.view.screenOf({ data: drawn.data.name, ...entity }, { signal: shown.lifetime })
        : null
    // What a GPU reset does, so a test can check that the Network draws on.
    hooks.gridkitLose = () => page.gpu?.lose()
    bridge.ready()
    return () => {
      closed = true
      lifetime.abort()
      playback?.()
      off()
      clock.stop()
      mapController?.abort()
      background.destroy?.()
      feed.clear()
      cases.clear()
      reads.clear()
      page.destroy()
    }
  })
</script>

<main class="canvas-host" aria-busy={busy}>
  {#if page.gpu && scene}
    <LatkitCanvas
      gpu={page.gpu}
      {scene}
      {sources}
      {active}
      {camera}
      onready={ready}
      ondrawn={drew}
      onerror={fail}
      label="Network view. Right-click an element for actions."
    />
  {/if}
  {#if busy}
    <div class="canvas-host__fallback c-empty" role="status">
      <p class="c-empty__text">Loading case…</p>
    </div>
  {/if}
  <div class="toolbar" data-testid="view-toolbar" role="toolbar" aria-label="Network display">
    {#each LOOKS as [label, glyph] (label)}
      <button
        class="c-icon-btn"
        aria-label={label}
        title={label}
        aria-pressed={label === look}
        disabled={label === 'Globe' && !geographic}
        onclick={() =>
          bridge.send({
            kind: 'display',
            values: {
              'network.projection': label === 'Globe' ? 'globe' : 'mercator',
              'network.tilt': label === 'Tilt' ? TILTED : 0,
            },
          })}
      >
        <Icon name={glyph} />
      </button>
    {/each}
    <button
      class="c-icon-btn"
      aria-label="Auto-rotate"
      title="Auto-rotate"
      aria-pressed={settings.get('network.orbit') !== 0}
      onclick={() =>
        bridge.send({
          kind: 'display',
          values: { 'network.orbit': settings.get('network.orbit') ? 0 : 8 },
        })}
    >
      <Icon name="orbit" />
    </button>
  </div>
</main>

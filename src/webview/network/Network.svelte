<!-- The Network: the case on a latkit canvas, with projection and orbit controls. The canvas
  view is destroyed while the page is hidden and reopens at its last camera. -->
<script lang="ts">
  import type { Camera, Data, Scene, Source } from 'latkit'
  import { onMount, untrack } from 'svelte'

  import type { Entity } from '../../shared/document.js'
  import type { Mappings } from '../../shared/mappings.js'
  import { revisionOf, type Summary, type ViewState } from '../../shared/messages.js'
  import { reader, TILTED } from '../../shared/settings.js'
  import { bridge } from '../bridge.js'
  import { createClock } from '../clock.js'
  import { imageOptions, saveImage, viewShot } from '../export/image.js'
  import type { CanvasView } from '../latkit/canvas.js'
  import { CaseRows } from '../latkit/data.js'
  import { MAX_FRAME_RATE, PlayheadFeed } from '../latkit/frames.js'
  import { bindInteractions } from '../latkit/interactions.js'
  import LatkitCanvas from '../latkit/LatkitCanvas.svelte'
  import { type Background, mapKey, mapOf, NO_MAP } from '../latkit/maps.js'
  import { LatkitPage } from '../latkit/page.svelte.js'
  import { caseFit, daylightOf, sampledFields, sceneFields, sceneOf } from '../latkit/scenes.js'
  import { nativeTheme } from '../latkit/theme.js'
  import { contextOf, nativeMenu } from '../menu.js'
  import Icon from '../ui/Icon.svelte'

  const PROJECTIONS = [
    ['Flat', 'projection-flat'],
    ['Tilt', 'projection-tilt'],
    ['Globe', 'projection-globe'],
  ] as const
  type Projection = (typeof PROJECTIONS)[number][0]

  interface LoadedCase {
    readonly data: Data
    readonly summary: Summary
    readonly fields: ReadonlyMap<string, ReadonlySet<string>>
  }

  interface CaseCamera {
    readonly uri?: string
    readonly camera?: Camera
  }

  const mark = (name: string) => {
    if (!performance.getEntriesByName(name).length) performance.mark(name)
  }
  mark('canvas:boot')

  const keyOf = (entities: readonly Entity[]) =>
    JSON.stringify(entities.map(({ table, id }) => [table, id]))

  const page = new LatkitPage((error) => {
    busy = false
    bridge.report(error, { view: 'network', phase: 'draw' })
  })
  const fail = page.fail
  const cases = new CaseRows()
  const feed = new PlayheadFeed({
    changed() {
      if (!closed) framesVersion++
    },
    failed: fail,
  })
  const lifetime = new AbortController()

  let viewState = $state.raw<ViewState>({})
  let loadedCase = $state.raw<LoadedCase>()
  let canvasView = $state.raw<CanvasView>()
  let background = $state.raw<Background>(NO_MAP)
  let busy = $state(true)
  let framesVersion = $state(0)
  let previousCamera = $state.raw<CaseCamera>()

  let closed = false
  let framingTimer: ReturnType<typeof setTimeout> | undefined
  /** Selection keys: the one shown, and the last one made in this view. */
  let shownSelection = ''
  let selectedHere = ''
  let backgroundKey = ''
  let mapController: AbortController | undefined
  /** The mappings drawn; newer ones apply once the rows have their fields. */
  let drawnMappings: Mappings = {}

  const active = $derived(page.active)
  const settings = $derived(reader(viewState.settings))
  const geographic = $derived(!!loadedCase?.summary.definition.drawing.geographic)
  const tilt = $derived(settings.get('network.tilt'))
  const projection = $derived<Projection>(
    geographic && settings.get('network.projection') === 'globe'
      ? 'Globe'
      : tilt > 0
        ? 'Tilt'
        : 'Flat',
  )
  // Read once per toggle: a time that changed on every rebuild would redraw the scene every time.
  const daylightOn = $derived(settings.get('network.map.daylight'))
  const daylight = $derived(daylightOf(daylightOn))
  const mappings = $derived.by(() => {
    if (!loadedCase) return drawnMappings
    const { fields } = loadedCase
    const asked = sceneFields(loadedCase.summary.definition, viewState.mappings)
    if (asked.every((type) => type.fields.every((name) => fields.get(type.table)?.has(name))))
      drawnMappings = viewState.mappings ?? {}
    return drawnMappings
  })
  const scene = $derived.by((): Scene | undefined => {
    void page.themeVersion
    void framesVersion
    if (!loadedCase) return undefined
    const { data, summary } = loadedCase
    return sceneOf(data, summary.definition, settings, nativeTheme(settings, 'network'), {
      mappings,
      results: viewState.results,
      sampled: feed.source,
      background,
      daylight,
    })
  })
  const sources = $derived.by((): Source[] => {
    void framesVersion
    return loadedCase ? [loadedCase.data, ...background.sources, ...feed.sources] : []
  })
  /** The camera a new view opens at: the last view's, else the one saved for this case. Without
   *  either, the view fits the whole case. */
  const camera = $derived.by(() => {
    const saved = previousCamera ?? bridge.state<CaseCamera>({})
    return saved.uri === viewState.uri ? saved.camera : undefined
  })

  const sampled = $derived(
    loadedCase && viewState.results?.frames
      ? sampledFields(loadedCase.summary.definition, viewState.mappings, viewState.results)
      : [],
  )

  function covered(at: number): boolean {
    return !sampled.length || feed.covers(sampled, at)
  }

  function prefetch(at: number) {
    if (!active || !loadedCase) return
    const results = viewState.results
    if (results?.frames && sampled.length)
      feed
        .ahead(sampled, at, {
          results,
          playing: clock.state.status === 'playing',
          rate: clock.state.rate,
          frameRate: MAX_FRAME_RATE,
        })
        .catch(() => {})
  }

  const clock = createClock((at) => {
    prefetch(at)
    if (canvasView && active && covered(at)) canvasView.view.at = at
  }, follow)

  function follow() {
    const view = canvasView?.view
    page.follow(
      !!view && clock.state.status === 'playing',
      () => (view && covered(clock.now()) ? [view] : []),
      () => {
        const at = clock.now()
        prefetch(at)
        return at
      },
    )
  }

  /** At most every 200 ms: saves the camera to reopen at, and sends the framing so exports match
   *  what the user saw. A hidden canvas reports nothing. */
  function scheduleFraming() {
    if (framingTimer) return
    framingTimer = setTimeout(() => {
      framingTimer = undefined
      if (!canvasView) return
      const { view, canvas } = canvasView
      const size = [canvas.clientWidth, canvas.clientHeight]
      if (!size[0] || !size[1]) return
      const { camera } = view
      bridge.save({ uri: viewState.uri, camera } satisfies CaseCamera)
      bridge.send({ kind: 'framing', framing: { camera, size } })
    }, 200)
  }

  /** Fits a new view to the whole case unless it opened at a saved camera. */
  function ready(opened: CanvasView) {
    const { view, canvas } = opened
    const uri = viewState.uri
    if (!camera && loadedCase)
      opened.fit(caseFit(loadedCase.data, loadedCase.summary.definition.drawing))
    previousCamera = undefined
    shownSelection = ''
    canvasView = opened
    const stop = bindInteractions(view, canvas, {
      select(element) {
        selectedHere = keyOf(element ? [element] : [])
        bridge.send({ kind: 'select', element })
      },
      open: (element) => bridge.send({ kind: 'open', element }),
      menu: (point, element) => nativeMenu(canvas, point, contextOf(viewState, 'network', element)),
      camera: scheduleFraming,
      error: fail,
    })
    // Report framing only after the first fit; until then the view shows only its background.
    const resizing = new ResizeObserver(scheduleFraming)
    void opened.framed().then(() => {
      if (canvasView === opened) resizing.observe(canvas)
    })
    return () => {
      previousCamera = { uri, camera: view.camera }
      stop()
      resizing.disconnect()
      clearTimeout(framingTimer)
      framingTimer = undefined
      if (canvasView === opened) canvasView = undefined
    }
  }

  function markRendered() {
    mark('canvas:frame')
    busy = false
  }

  async function loadBackground() {
    const key = mapKey(settings, geographic)
    if (backgroundKey === key) return
    backgroundKey = key
    mapController?.abort()
    const controller = (mapController = new AbortController())
    try {
      const next = await mapOf(settings, geographic, controller.signal)
      if (!controller.signal.aborted && !closed) background = next
    } catch (error) {
      if (!controller.signal.aborted) {
        backgroundKey = ''
        fail(error)
      }
    }
  }

  $effect(() => {
    void page.themeVersion
    void loadBackground()
  })
  $effect(() => {
    const mapped = sampled
    untrack(() => feed.keep(mapped))
  })
  $effect(() => {
    if (canvasView) canvasView.view.orbit = settings.get('network.orbit')
  })
  // Setting only the pitch keeps any pending fit.
  $effect(() => {
    if (canvasView) canvasView.view.camera = { pitch: tilt }
  })
  $effect(() => {
    void framesVersion
    void loadedCase
    if (canvasView && covered(clock.now())) canvasView.view.at = clock.now()
  })
  // Show the selection, and frame it unless it was picked in this view.
  $effect(() => {
    if (!canvasView || !loadedCase) return
    const data = loadedCase.data.name
    const entities = viewState.networkSelection ?? []
    const key = keyOf(entities)
    if (key === shownSelection) return
    shownSelection = key
    canvasView.view.selection = entities.map((entity) => ({
      data,
      table: entity.table,
      ids: [entity.id],
    }))
    if (entities[0] && key !== selectedHere) canvasView.fit({ reveal: { data, ...entities[0] } })
  })
  $effect(() => {
    void canvasView
    void page.gpu
    void active
    follow()
  })

  onMount(() => {
    const off = bridge.on((message) => {
      if (message.kind === 'state') {
        const previous = viewState
        viewState = message.state
        if (previous.uri !== viewState.uri) {
          loadedCase = undefined
          cases.clear()
        }
        if (previous.uri !== viewState.uri || previous.results?.id !== viewState.results?.id) {
          feed.clear()
          framesVersion++
        }
        const next = viewState.summary
        if (next && !viewState.stale) {
          const fields = sceneFields(next.definition, viewState.mappings)
          void cases
            .receive({ revision: revisionOf(next), fields }, fields)
            .then((changed) => {
              if (!changed || closed) return
              loadedCase = {
                data: cases.slot.current!.data,
                summary: next,
                fields: new Map(fields.map((type) => [type.table, new Set(type.fields)])),
              }
              mark('canvas:data')
            })
            .catch(fail)
        }
        prefetch(clock.now())
        if (!viewState.summary && viewState.error) busy = false
      } else if (message.kind === 'action') {
        if (message.command === 'reloadView') void page.open()
        else if (message.command === 'fitAll' && canvasView && loadedCase)
          canvasView.fit(caseFit(loadedCase.data, loadedCase.summary.definition.drawing))
        else if (message.command === 'exportImage' && canvasView && loadedCase && viewState.uri) {
          const [exported, uri, name] = [canvasView, viewState.uri, loadedCase.summary.name]
          const options = imageOptions(viewState.exportSettings)
          // Wait for the first fit, so the image is never just the background.
          void exported
            .framed()
            .then(() =>
              saveImage(
                viewShot(exported.view, options),
                uri,
                name,
                'network',
                options,
                lifetime.signal,
              ),
            )
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
      summary: loadedCase?.summary.version,
      rows: cases.slot.current?.key,
      view: !!canvasView,
      gpu: !!page.gpu,
    })
    hooks.gridkitStats = () => {
      const gpu = page.gpu
      if (!canvasView || !gpu) return undefined
      const { view } = canvasView
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
        mappings: drawnMappings,
      }
    }
    hooks.gridkitSelection = () =>
      canvasView && {
        entities: canvasView.view.selection.flatMap((group) =>
          group.ids.map((id) => ({ table: group.table, id })),
        ),
        camera: canvasView.view.camera,
      }
    hooks.gridkitLocate = (entity) =>
      canvasView && loadedCase
        ? canvasView.view.screenOf(
            { data: loadedCase.data.name, ...entity },
            { signal: canvasView.lifetime },
          )
        : null
    // Simulates a GPU reset, so tests can check that the Network keeps drawing.
    hooks.gridkitLose = () => page.gpu?.lose()
    bridge.ready()
    return () => {
      closed = true
      lifetime.abort()
      off()
      clock.stop()
      mapController?.abort()
      feed.clear()
      cases.clear()
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
      ondrawn={markRendered}
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
    {#each PROJECTIONS as [label, glyph] (label)}
      <button
        class="c-icon-btn"
        aria-label={label}
        title={label}
        aria-pressed={label === projection}
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
      aria-label="Orbit"
      title="Orbit"
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

import './style.css'

import { colormap } from '@latkit/colormaps'
import type { Colormap, Item, RGBA } from '@latkit/model'
import { createNetwork, type Pose, PROJECTIONS } from '@latkit/network'
import { loadBorders } from '@latkit/network/borders'
import { spotlight } from '@latkit/network/shades'

import { DISPLAY_CHANNELS, type DisplayChannel } from '../../bindings.js'
import { describe } from '../../errors.js'
import { type Capabilities, menuContext, NO_CAPABILITIES } from '../../menus.js'
import type { CaseTarget, Selection } from '../../targets.js'
import { port, vscode } from '../../webview/client.js'
import { isProjection, type ToWebview } from '../messages.js'
import { type DisplayOptions, rendererOptions, validOptions } from '../options.js'

const canvas = document.querySelector<HTMLCanvasElement>('#network')!
const notice = document.querySelector<HTMLElement>('#notice')!
const message = document.querySelector<HTMLElement>('#message')!
const retry = document.querySelector<HTMLButtonElement>('#retry')!
const network = createNetwork({
  keyboard: true,
  motion: 'auto',
  interaction: 'navigate',
  daylight: false,
})
const saved = vscode.getState() as
  { projection?: unknown; pose?: Pose; options?: DisplayOptions } | undefined
let options: DisplayOptions = validOptions(saved?.options) ? saved.options : { colormap: 'viridis' }
let caseColormap: Colormap | undefined
let selection: Item | null = null
let applyingSelection = false
let subject: Selection | null = null
let subjectCapabilities: Capabilities = NO_CAPABILITIES
let capabilities: Partial<Record<'vertex' | 'edge', Capabilities>> = {}
function applySelection(item: Item | null) {
  applyingSelection = true
  try {
    network.select(item)
  } finally {
    applyingSelection = false
  }
}
let channelValues: Partial<Record<DisplayChannel, Float32Array>> = {}
let target: CaseTarget | undefined
let orbiting = false
let branchColorsFromBuses = true
const bordersRead = new AbortController()
let current: Extract<ToWebview, { type: 'scene' }> | undefined
let queued: typeof current
let version = -1
let drawing = false
let disposed = false
let first = true
let saveTimer: ReturnType<typeof setTimeout> | undefined
let mode: 'pending' | 'ready' | 'invalid' | 'error' | 'empty' = 'pending'

function status(next: typeof mode, text = ''): void {
  mode = next
  document.body.dataset.state = next
  canvas.inert = next !== 'ready'
  canvas.setAttribute('aria-busy', String(next === 'pending'))
  message.textContent = text
  notice.hidden = next === 'ready'
  retry.hidden = next !== 'error'
}

function fail(error: unknown): void {
  if (disposed) return
  network.pause()
  status('error', 'Network rendering is unavailable. You can continue in the JSON editor.')
  if (target)
    vscode.postMessage({ type: 'error', ...target, message: describe(error).slice(0, 2000) })
}

function color(property: string, fallback: RGBA): RGBA {
  const value = getComputedStyle(document.body).getPropertyValue(property).trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value)?.[1]
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
    return [
      parseInt(full.slice(0, 2), 16) / 255,
      parseInt(full.slice(2, 4), 16) / 255,
      parseInt(full.slice(4, 6), 16) / 255,
      full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
    ]
  }
  const rgb = /^rgba?\(([^)]+)\)$/
    .exec(value)?.[1]
    .split(/[,\s/]+/)
    .map(Number)
  return rgb && rgb.length >= 3 && rgb.every(Number.isFinite)
    ? [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, rgb[3] ?? 1]
    : fallback
}

function theme(): void {
  canvas.dataset.branchColorsFromBuses = String(branchColorsFromBuses)
  const foreground = color('--vscode-editor-foreground', [0.7, 0.7, 0.7, 1])
  network.setOptions({
    vertexBaseColor: foreground,
    edgeBaseColor: branchColorsFromBuses
      ? null
      : [foreground[0], foreground[1], foreground[2], 0.65],
    surfaceColor: color('--vscode-editor-background', [0.1, 0.1, 0.1, 1]),
    borderColor: [foreground[0], foreground[1], foreground[2], 0.25],
    selectedColor: color('--vscode-focusBorder', [0, 0.5, 1, 1]),
    hoverColor: color('--vscode-focusBorder', [0, 0.5, 1, 1]),
    ...rendererOptions(options),
    ...(caseColormap && { colormap: caseColormap }),
    ...(branchColorsFromBuses && { edgeBaseColor: null }),
  })
}

function save(): void {
  if (first || disposed) return
  vscode.setState({ projection: network.projection, pose: network.getPose(), options })
}

function view(): void {
  canvas.setAttribute(
    'aria-label',
    `Power system network, ${network.projection} projection. Select an element, then use Show Source in the editor toolbar.`,
  )
  if (target)
    vscode.postMessage({
      type: 'view',
      ...target,
      projection: network.projection,
      options,
      projections: PROJECTIONS.filter((mode) => network.projections[mode]),
    })
  save()
}

async function draw(): Promise<void> {
  if (drawing || disposed) return
  drawing = true
  try {
    while (queued && !disposed) {
      const scene = queued
      queued = undefined
      const isCurrent = () => scene.topology === current?.topology && current.version === version
      if (!isCurrent()) continue
      try {
        if (!scene.topology.vertexCount) {
          network.pause()
          status('empty', 'This case contains no buses.')
          continue
        }
        network.load(scene.topology, { fit: first })
        if (first && isProjection(saved?.projection)) network.setProjection(saved.projection, true)
        if (!network.attached) await network.attach(canvas)
        if (disposed) return
        if (
          first &&
          saved?.pose &&
          ['centerX', 'centerY', 'pitch', 'bearing'].every((key) =>
            Number.isFinite(saved.pose![key as keyof Pose]),
          )
        )
          network.setPose(saved.pose)
        first = false
        if (!isCurrent()) continue
        applyChannels()
        applySelection(selection)
        network.resume()
        await network.paint()
        if (disposed || !isCurrent() || mode === 'error') continue
        status('ready')
        // Channel reads may finish while the first paint is in flight.
        applyChannels()
        applySelection(selection)
        document.body.dataset.version = String(version)
        view()
        if (scene.topology.vertexCoords) {
          void loadBorders(bordersRead.signal).then(
            (borders) => {
              if (!disposed && isCurrent()) network.setBorders(borders)
            },
            (error) => console.warn('GridKit borders:', error),
          )
        }
      } catch (error) {
        if (!disposed && isCurrent()) fail(error)
      }
    }
  } finally {
    drawing = false
  }
}

function applyChannels(): void {
  for (const channel of DISPLAY_CHANNELS)
    network.setChannel(channel, channelValues[channel] ?? null, [0, 1])
  canvas.dataset.bindings = Object.keys(channelValues).join(',')
}

port.subscribe((message) => {
  const data = message as ToWebview
  if (disposed || !data || typeof data !== 'object') return
  if ('version' in data) {
    if (data.version < version) return
    if (
      data.type !== 'target' &&
      (data.version !== version || data.revision !== target?.revision)
    ) {
      applySelection(null)
      selection = null
      channelValues = {}
    }
    version = data.version
    target = { uri: data.uri, version: data.version, revision: data.revision }
  }
  switch (data.type) {
    case 'target':
      if (current) current = { ...current, ...target! }
      document.body.dataset.version = String(version)
      break
    case 'settings':
      branchColorsFromBuses = data.branchColorsFromBuses
      theme()
      break
    case 'scene':
      document.body.dataset.case = data.uri
      if (
        current?.version === data.version &&
        (mode === 'ready' || (mode === 'pending' && drawing))
      )
        return
      current = data
      queued = data
      status('pending', 'Updating network...')
      void draw()
      break
    case 'pending':
      queued = undefined
      network.pause()
      status('pending', 'Updating network...')
      break
    case 'invalid':
      queued = undefined
      current = undefined
      network.pause()
      status('invalid', data.message)
      break
    case 'selection':
      subject = data.selection
      subjectCapabilities = data.capabilities
      const moved = selection?.kind !== data.item?.kind || selection?.index !== data.item?.index
      selection = data.item
      applySelection(selection)
      if (data.navigate !== false && moved && selection && mode === 'ready')
        network.reveal(selection, { animate: true })
      canvas.dataset.selected = selection ? `${selection.kind}:${selection.index}` : ''
      break
    case 'context':
      capabilities = data.capabilities
      break
    case 'channels':
      if (data.colormap) {
        const palette = colormap(data.colormap as Parameters<typeof colormap>[0])
        caseColormap = (t) =>
          t < 1 / 255
            ? [0.5, 0.5, 0.5]
            : palette(Math.max(0, Math.min(1, (t - 2 / 255) / (253 / 255))))
        network.setOptions({ colormap: caseColormap })
        for (const key of ['vertexColor', 'edgeColor'] as const)
          if (data.values[key])
            data.values[key] = Float32Array.from(data.values[key]!, (value) =>
              Number.isFinite(value) ? 2 / 255 + value * (253 / 255) : 0,
            )
      }
      channelValues = data.values
      if (mode === 'ready') applyChannels()
      break
    case 'reveal':
      if (mode === 'ready') network.reveal(data.item, { neighbors: data.neighbors, animate: true })
      break
    case 'options':
      if (validOptions(data.options)) {
        options = { ...options, ...data.options }
        theme()
        if ('shade' in data.options)
          void network.setShade(options.shade === 'spotlight' ? spotlight() : null).catch(fail)
        view()
      }
      break
    case 'orbit':
      orbiting = network.orbit(!orbiting)
      break
    case 'fit':
      if (mode === 'ready') network.fit()
      break
    case 'projection':
      if (mode === 'ready' && isProjection(data.projection)) {
        network.setProjection(data.projection, true)
        view()
      }
      break
  }
})

network.on('select', (item) => {
  if (!applyingSelection && mode === 'ready' && target) {
    selection = item
    vscode.postMessage({ type: 'select', ...target, item })
  }
})
window.addEventListener('focus', () => vscode.postMessage({ type: 'focus' }))
canvas.addEventListener('focus', () => vscode.postMessage({ type: 'focus' }))
network.on('orbit', (active) => {
  orbiting = active
})
network.on('contextmenu', ({ clientX, clientY, items, keyboard }) => {
  if (!target || mode !== 'ready' || !current) return
  const refs = items.slice(0, 100).flatMap((item) => {
    const classId = current!.owners[item.kind]
    return classId ? [{ classId, index: item.index }] : []
  })
  const menu = document.querySelector<HTMLElement>('#context')!
  const capability =
    keyboard && subject ? subjectCapabilities : items[0] ? capabilities[items[0].kind] : undefined
  const contextTarget =
    keyboard && subject ? { ...target, ...subject } : { ...target, element: refs[0], items: refs }
  menu.dataset.vscodeContext = JSON.stringify(
    menuContext(contextTarget, capability ?? NO_CAPABILITIES, 'network'),
  )
  menu.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX, clientY }))
})
network.on('deviceLost', (event) => {
  if (!event.recovering) fail(event.message)
})
network.on('pipelineError', (event) => fail(event.cause))
document
  .querySelector('#source')!
  .addEventListener('click', () => vscode.postMessage({ type: 'source' }))
retry.addEventListener('click', () => {
  if (!current || current.version !== version) return
  network.detach()
  queued = current
  status('pending', 'Loading network...')
  void draw()
})

for (const event of ['pointerup', 'keyup', 'wheel']) {
  canvas.addEventListener(event, () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, 600)
  })
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    save()
    network.pause()
  } else {
    network.resume()
    vscode.postMessage({ type: 'ready' })
  }
})
const observer = new MutationObserver(theme)
observer.observe(document.body, {
  attributes: true,
  attributeFilter: ['class', 'style', 'data-vscode-theme-id'],
})
window.addEventListener(
  'pagehide',
  () => {
    save()
    disposed = true
    clearTimeout(saveTimer)
    observer.disconnect()
    bordersRead.abort()
    network.destroy()
  },
  { once: true },
)
theme()
if (options.shade === 'spotlight') void network.setShade(spotlight()).catch(fail)
status('pending', 'Loading network...')
vscode.postMessage({ type: 'ready' })

import { arrange, type Diagram } from '@latkit/diagram'
import type { Gpu } from '@latkit/gpu'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Summary, ViewState } from '../../shared/messages.js'
import { bridge } from '../bridge.js'
import { editing } from './edit.js'

vi.mock('@latkit/diagram', () => ({ arrange: vi.fn() }))
vi.mock('../bridge.js', () => ({ bridge: { request: vi.fn(), send: vi.fn() } }))

describe('diagram edit lifetime', () => {
  beforeEach(() => vi.resetAllMocks())

  function fixture() {
    const events = new Map<string, (proposal: unknown) => void>()
    const diagram = {
      config: { vertices: { Block: {} } },
      on: (name: string, listener: (proposal: unknown) => void) => events.set(name, listener),
    } as unknown as Diagram
    const state: ViewState = { summary: { version: 1 } as Summary, writable: true }
    const controller = new AbortController()
    let resolve!: (positions: Awaited<ReturnType<typeof arrange>>) => void
    const promise = new Promise<Awaited<ReturnType<typeof arrange>>>((done) => {
      resolve = done
    })
    const layout = { resolve }
    vi.mocked(arrange).mockReturnValue(promise)
    const refuse = vi.fn()
    const commit = editing(diagram, {} as Gpu, () => state, controller.signal, refuse)
    return { events, controller, layout, commit, refuse }
  }

  it('passes cancellation to arrangement and rejects a late edit', async () => {
    const { controller, layout, commit } = fixture()
    const pending = commit()
    expect(arrange).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      signal: controller.signal,
    })
    controller.abort()
    layout.resolve({})
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(bridge.request).not.toHaveBeenCalled()
  })

  it('ignores a move after closure without committing or requesting another layout', async () => {
    const { events, controller, refuse } = fixture()
    controller.abort()
    events.get('move')!({ positions: {} })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(arrange).not.toHaveBeenCalled()
    expect(bridge.request).not.toHaveBeenCalled()
    expect(refuse).not.toHaveBeenCalled()
  })

  it('says in the view, not a notification, why an edit did not happen', async () => {
    const { events, refuse } = fixture()
    events.get('connect')!({ from: { kind: 'vertex' }, to: null })
    expect(refuse).toHaveBeenCalledWith('Start a connection at a signal port.')
    expect(bridge.send).not.toHaveBeenCalled()
  })
})

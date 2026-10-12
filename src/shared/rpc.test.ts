import { describe, expect, it, vi } from 'vitest'

import { problem } from './errors.js'
import {
  answerer,
  Caller,
  type Cancel,
  type Handlers,
  type Reply,
  type Request,
  resent,
} from './rpc.js'

interface Echo {
  echo: { input: { text: string }; output: string }
  fail: { input: { code?: string; offset?: number }; output: never }
  wait: { input: Record<string, never>; output: never }
}

/** A caller and its answerer, wired as two sides of one channel, every message kept. */
function channel(handlers: Handlers<Echo>, post?: (reply: Reply) => void) {
  const sent: (Request | Cancel | Reply)[] = []
  let caller!: Caller<Echo>
  const answering = answerer<Echo>(handlers, (reply) => {
    sent.push(reply)
    if (post) post(reply)
    else caller.settle(reply)
  })
  caller = new Caller<Echo>((message) => {
    sent.push(message)
    answering.receive(message)
  })
  return { caller, answering, sent }
}

const handlers: Handlers<Echo> = {
  echo: async ({ text }) => text,
  fail: async ({ code, offset }) => {
    throw Object.assign(new Error('It failed.'), { code, offset, length: 2 })
  },
  wait: (_, signal) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
}

describe('a request across a channel', () => {
  it('settles with its answer, or the problem it met', async () => {
    const { caller } = channel(handlers)
    expect(await caller.call('echo', { text: 'hi' })).toBe('hi')
    const failed = await caller
      .call('fail', { code: 'superseded', offset: 4 })
      .catch((error) => error)
    expect(failed).toBeInstanceOf(Error)
    expect(failed).toMatchObject({
      message: 'It failed.',
      code: 'superseded',
      offset: 4,
      length: 2,
    })
    expect(failed.detail).toMatch(/It failed/)
    // A failure with no code of its own has the general one.
    await expect(caller.call('fail', {})).rejects.toMatchObject({ code: 'operation-failed' })
    await expect(caller.call('missing' as 'echo', { text: '' })).rejects.toThrow(
      /Nothing answers missing/,
    )
  })

  it('marks a defect, which the user is never told as it was thrown', async () => {
    const { caller } = channel({
      ...handlers,
      echo: async () => {
        throw new TypeError('undefined is not a function')
      },
    })
    await expect(caller.call('echo', { text: '' })).rejects.toMatchObject({ defect: true })
  })

  it('stops the answer when the caller lets go of it, and sends no reply', async () => {
    let heard: AbortSignal | undefined
    const { caller, sent } = channel({
      ...handlers,
      wait: (input, signal) => {
        heard = signal
        return handlers.wait(input, signal)
      },
    })
    const controller = new AbortController()
    const call = caller.call('wait', {}, controller.signal)
    controller.abort()
    await expect(call).rejects.toMatchObject({ name: 'AbortError' })
    expect(heard?.aborted).toBe(true)
    // The answer settles in microtasks alone, all run before the next macrotask.
    await new Promise((resolve) => setImmediate(resolve))
    expect(sent.map(({ kind }) => kind)).toEqual(['request', 'cancel'])
  })

  it('fails a call whose input cannot cross, and keeps nothing of it', async () => {
    const post = vi.fn(() => {
      throw new DOMException('could not be cloned', 'DataCloneError')
    })
    const caller = new Caller<Echo>(post)
    const controller = new AbortController()
    await expect(caller.call('echo', { text: 'hi' }, controller.signal)).rejects.toThrow(
      'could not be cloned',
    )
    // Nothing waits on it any more, so letting go of it sends no cancellation.
    controller.abort()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('answers a value that cannot cross as a defect', async () => {
    let refused = false
    let caller!: Caller<Echo>
    const { caller: asking } = channel(handlers, (reply) => {
      if (!refused && reply.problem === undefined) {
        refused = true
        throw new DOMException('could not be cloned', 'DataCloneError')
      }
      caller.settle(reply)
    })
    caller = asking
    await expect(caller.call('echo', { text: 'hi' })).rejects.toMatchObject({ defect: true })
  })

  it('fails every call under way when the other side is gone', async () => {
    const post = vi.fn()
    const caller = new Caller<Echo>(post)
    const calls = [caller.call('wait', {}), caller.call('echo', { text: 'hi' })]
    caller.fail(new Error('The worker stopped.'))
    for (const call of calls) await expect(call).rejects.toThrow('The worker stopped.')
    // A reply that comes after settles nothing.
    caller.settle({ kind: 'reply', id: 1, value: 'late' })
  })

  it('sends what the other side lacks only when it says it lacks it', async () => {
    const sent: string[] = []
    const call = async (input: string) => {
      sent.push(input)
      if (input === 'lean') throw problem('needs-source', 'Send the source.')
      return input
    }
    expect(await resent(call, 'needs-source', 'lean', () => 'whole')).toBe('whole')
    expect(sent).toEqual(['lean', 'whole'])
    // Any other failure is the call's own.
    await expect(resent(call, 'stale-source', 'lean', () => 'whole')).rejects.toMatchObject({
      code: 'needs-source',
    })
    // Nor is it sent again once the asker let go.
    const controller = new AbortController()
    controller.abort()
    await expect(
      resent(call, 'needs-source', 'lean', () => 'whole', controller.signal),
    ).rejects.toMatchObject({ code: 'needs-source' })
  })

  it('lets go of every answer under way at once', async () => {
    const signals: AbortSignal[] = []
    const { caller, answering } = channel({
      ...handlers,
      wait: (input, signal) => {
        signals.push(signal)
        return handlers.wait(input, signal)
      },
    })
    void caller.call('wait', {}).catch(() => {})
    void caller.call('wait', {}).catch(() => {})
    answering.cancel()
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true])
  })
})

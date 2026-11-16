import { describe, expect, it, vi } from 'vitest'

import { answerer, Caller, type Cancel, type Handlers, type Reply, type Request } from './rpc.js'

interface Echo {
  echo: { input: { text: string }; output: string }
  fail: { input: { code?: string; line?: number }; output: never }
  wait: { input: Record<string, never>; output: never }
}

/** A caller and an answerer wired as the two sides of one channel, recording every message. */
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
  fail: async ({ code, line }) => {
    const range = line === undefined ? undefined : { start: [line, 0], end: [line, 2] }
    throw Object.assign(new Error('It failed.'), { code, range })
  },
  wait: (_, signal) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
}

describe('a request across a channel', () => {
  it('resolves with the reply, or rejects with the error', async () => {
    const { caller } = channel(handlers)
    expect(await caller.call('echo', { text: 'hi' })).toBe('hi')
    const failed = await caller
      .call('fail', { code: 'superseded', line: 4 })
      .catch((error) => error)
    expect(failed).toBeInstanceOf(Error)
    // The case file location crosses with the error.
    expect(failed).toMatchObject({
      message: 'It failed.',
      code: 'superseded',
      range: { start: [4, 0], end: [4, 2] },
    })
    expect(failed.detail).toMatch(/It failed/)
    // A failure without a code gets the generic one.
    await expect(caller.call('fail', {})).rejects.toMatchObject({ code: 'operation-failed' })
    await expect(caller.call('missing' as 'echo', { text: '' })).rejects.toThrow(
      /Nothing answers missing/,
    )
  })

  it('marks an unexpected error as a defect', async () => {
    const { caller } = channel({
      ...handlers,
      echo: async () => {
        throw new TypeError('undefined is not a function')
      },
    })
    await expect(caller.call('echo', { text: '' })).rejects.toMatchObject({ defect: true })
  })

  it('aborts the handler when the caller aborts, and sends no reply', async () => {
    let received: AbortSignal | undefined
    const { caller, sent } = channel({
      ...handlers,
      wait: (input, signal) => {
        received = signal
        return handlers.wait(input, signal)
      },
    })
    const controller = new AbortController()
    const call = caller.call('wait', {}, controller.signal)
    controller.abort()
    await expect(call).rejects.toMatchObject({ name: 'AbortError' })
    expect(received?.aborted).toBe(true)
    // The handler settles in microtasks, which all run before the next macrotask.
    await new Promise((resolve) => setImmediate(resolve))
    expect(sent.map(({ kind }) => kind)).toEqual(['request', 'cancel'])
  })

  it('fails a call whose input cannot be cloned, and keeps no record of it', async () => {
    const post = vi.fn(() => {
      throw new DOMException('could not be cloned', 'DataCloneError')
    })
    const caller = new Caller<Echo>(post)
    const controller = new AbortController()
    await expect(caller.call('echo', { text: 'hi' }, controller.signal)).rejects.toThrow(
      'could not be cloned',
    )
    // The call already settled, so aborting sends no cancellation.
    controller.abort()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('reports a reply that cannot be cloned as a defect', async () => {
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

  it('fails every pending call when the other side stops', async () => {
    const post = vi.fn()
    const caller = new Caller<Echo>(post)
    const calls = [caller.call('wait', {}), caller.call('echo', { text: 'hi' })]
    caller.fail(new Error('The worker stopped.'))
    for (const call of calls) await expect(call).rejects.toThrow('The worker stopped.')
    // A late reply settles nothing.
    caller.settle({ kind: 'reply', id: 1, value: 'late' })
  })

  it('aborts every running handler at once', async () => {
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

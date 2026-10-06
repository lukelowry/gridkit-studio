import { beforeEach, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  listeners: new Set<(event: { execution: vscode.TaskExecution }) => void>(),
}))
vi.mock('vscode', () => ({
  tasks: {
    executeTask: mocks.execute,
    onDidEndTask: (listener: (event: { execution: vscode.TaskExecution }) => void) => {
      mocks.listeners.add(listener)
      return { dispose: () => mocks.listeners.delete(listener) }
    },
  },
}))
import { executeTracked } from './tasks.js'

beforeEach(() => {
  mocks.listeners.clear()
  mocks.execute.mockReset()
})
const task = {} as vscode.Task
const end = (execution: vscode.TaskExecution) => {
  for (const listener of mocks.listeners) listener({ execution })
}

it('ignores an older execution of the same task and observes its own early completion', async () => {
  let schedule!: (execution: vscode.TaskExecution) => void
  const scheduled = new Promise<vscode.TaskExecution>((resolve) => {
    schedule = resolve
  })
  const own = { task } as vscode.TaskExecution
  const previous = { task } as vscode.TaskExecution
  mocks.execute.mockReturnValue(scheduled)
  const finished = vi.fn()
  const tracking = executeTracked(task, finished)
  end(previous)
  end(own)
  expect(finished).not.toHaveBeenCalled()
  schedule(own)
  const subscription = await tracking
  expect(finished).toHaveBeenCalledTimes(1)
  end(previous)
  expect(finished).toHaveBeenCalledTimes(1)
  subscription.dispose()
  expect(mocks.listeners.size).toBe(0)
})

it('observes later completion and disposes a failed scheduling subscription', async () => {
  const own = { task } as vscode.TaskExecution
  mocks.execute.mockResolvedValueOnce(own)
  const finished = vi.fn()
  const subscription = await executeTracked(task, finished)
  end({ task } as vscode.TaskExecution)
  expect(finished).not.toHaveBeenCalled()
  end(own)
  expect(finished).toHaveBeenCalledTimes(1)
  subscription.dispose()
  mocks.execute.mockRejectedValueOnce(new Error('Scheduling refused'))
  await expect(executeTracked(task, finished)).rejects.toThrow('Scheduling refused')
  expect(mocks.listeners.size).toBe(0)
})

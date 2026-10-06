import { describe, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'

import { toolResult } from './output.js'

vi.mock('vscode', () => ({
  CancellationError: class extends Error {},
  LanguageModelToolResult: class {
    constructor(readonly content: unknown[]) {}
  },
  LanguageModelTextPart: class {
    constructor(readonly value: string) {}
  },
}))
const token = { isCancellationRequested: false } as vscode.CancellationToken
const json = (result: vscode.LanguageModelToolResult) =>
  JSON.parse((result.content[0] as vscode.LanguageModelTextPart).value)

describe('AI response budgets', () => {
  it('does not change a result shared with other clients', async () => {
    const rows = Object.freeze(
      Array.from({ length: 100 }, (_, id) => ({ id, name: 'x'.repeat(1000) })),
    )
    const source = Object.freeze({ rows, offset: 0, total: 100, nextOffset: null })
    await toolResult(source, token)
    expect(source.rows).toBe(rows)
    expect(source.rows).toHaveLength(100)
    expect(source.nextOffset).toBeNull()
    expect(source).not.toHaveProperty('truncated')
  })
  it('keeps useful rows, counts, continuation and failure evidence under the host budget', async () => {
    const result = await toolResult(
      {
        rows: Array.from({ length: 100 }, (_, n) => ({ id: 'Bus/' + n, value: 'x'.repeat(500) })),
        offset: 10,
        total: 200,
        failed: [1, 2],
        nextOffset: 110,
      },
      token,
      { tokenBudget: 1500, countTokens: async (text) => text.length },
    )
    const found = json(result)
    expect(found.rows.length).toBeGreaterThan(0)
    expect(found.rows.length).toBeLessThan(100)
    expect(found.nextOffset).toBe(10 + found.rows.length)
    expect(found.total).toBe(200)
    expect(found.failed).toEqual([1, 2])
    expect(found.truncated).toBe(true)
    expect(JSON.stringify(found).length).toBeLessThanOrEqual(1500)
  })
  it('returns a result whole where the host sets no budget', async () => {
    const whole = await toolResult(
      { rows: [{ name: 'x'.repeat(1 << 20) }], offset: 0, total: 1 },
      token,
    )
    expect(json(whole).rows[0].name).toHaveLength(1 << 20)
    expect(json(whole)).not.toHaveProperty('truncated')
  })
  it('does not silently remove semantic metadata or produce a nonadvancing cursor', async () => {
    const budget = { tokenBudget: 1000, countTokens: async (text: string) => text.length }
    const huge = await toolResult(
      { rows: [{ name: 'x'.repeat(40_000) }], offset: 0, total: 1 },
      token,
      budget,
    )
    expect(json(huge)).toMatchObject({ rows: [], truncated: true })
    expect(json(huge).nextOffset).toBeUndefined()
    await expect(toolResult({ failed: ['x'.repeat(40_000)] }, token, budget)).rejects.toThrow(
      /metadata exceeds/,
    )
    await expect(
      toolResult({ rows: [] }, { isCancellationRequested: true } as vscode.CancellationToken),
    ).rejects.toThrow()
  })
})

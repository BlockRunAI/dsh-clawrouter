import { describe, expect, it } from 'vitest'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { renderSpend, SpendMeter } from '../src/spend.ts'
import { projectRates } from '../src/catalog.ts'

const usage = (input: number, output: number, cacheRead = 0): TokenUsage => ({
  inputTokens: input,
  outputTokens: output,
  ...cacheRead === 0 ? {} : { cacheReadTokens: cacheRead },
})

const PRICE = 0.002

describe('SpendMeter', () => {
  it('prices per request, not per token', () => {
    // Measured against the wallet: a call generating 8,000 output tokens cost
    // exactly the same as one generating 3. Settlement follows the signed 402
    // quote and is independent of what the model then produced.
    const perToken = new SpendMeter(PRICE)
    perToken.record('deepseek/deepseek-chat', usage(17, 8_000))
    const perCall = new SpendMeter(PRICE)
    perCall.record('deepseek/deepseek-chat', usage(17, 3))
    expect(perToken.summary().totalUsd).toBe(perCall.summary().totalUsd)
    expect(perToken.summary().totalUsd).toBeCloseTo(PRICE, 10)
  })

  it('totals as calls times the per-request price', () => {
    const meter = new SpendMeter(PRICE)
    for (let i = 0; i < 3; i++) meter.record('deepseek/deepseek-chat', usage(14, 1))
    // The exact figure three real calls moved a funded wallet by.
    expect(meter.summary().totalUsd).toBeCloseTo(0.006, 10)
    expect(meter.summary().calls).toBe(3)
  })

  it('carries token counts without pricing them', () => {
    const meter = new SpendMeter(PRICE)
    meter.record('m', usage(100, 20, 50))
    const summary = meter.summary()
    // Cache reads still count as input tokens for context; they simply do not
    // become money, because nothing here does.
    expect(summary.inputTokens).toBe(150)
    expect(summary.outputTokens).toBe(20)
    expect(renderSpend(summary)).toMatch(/not billed by token/)
  })

  it('ranks models by how often they were called', () => {
    const meter = new SpendMeter(PRICE)
    meter.record('quiet', usage(10, 10))
    meter.record('busy', usage(10, 10))
    meter.record('busy', usage(10, 10))
    expect(meter.summary().byModel.map(entry => entry.model)).toEqual(['busy', 'quiet'])
  })

  it('starts empty and says so', () => {
    // Not a confident $0, which reads as "this route is free".
    expect(renderSpend(new SpendMeter(PRICE).summary())).toMatch(/No BlockRun requests yet/)
  })

  it('states what the figure is and is not', () => {
    const meter = new SpendMeter(PRICE)
    meter.record('deepseek/deepseek-chat', usage(14, 1))
    const text = renderSpend(meter.summary())
    expect(text).toMatch(/Priced per request, not per token/)
    expect(text).toMatch(/wallet balance is the authority/)
    // Small amounts stay legible rather than rounding to $0.00.
    expect(text).not.toMatch(/\$0\.00\b/)
  })
})

describe('projectRates', () => {
  it('still reads published rates, which selectors may want to show', () => {
    const rates = projectRates({
      data: [
        { id: 'deepseek/deepseek-chat', pricing: { input: 0.14, output: 0.28 } },
        { id: 'unpriced/model' },
        { id: 'bad/model', pricing: { input: -1 } },
      ],
    })
    expect(rates.get('deepseek/deepseek-chat')).toEqual({ input: 0.14, output: 0.28 })
    expect(rates.has('unpriced/model')).toBe(false)
    expect(rates.has('bad/model')).toBe(false)
  })
})

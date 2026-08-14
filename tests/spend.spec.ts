import { describe, expect, it } from 'vitest'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { renderSpend, SpendMeter, tokenCost } from '../src/spend.ts'
import { projectRates } from '../src/catalog.ts'

const usage = (input: number, output: number, cacheRead = 0): TokenUsage => ({
  inputTokens: input,
  outputTokens: output,
  ...cacheRead === 0 ? {} : { cacheReadTokens: cacheRead },
})

// DeepSeek V4 Flash's published rates.
const FLASH = { input: 0.14, output: 0.28 }

describe('tokenCost', () => {
  it('prices a call from published per-million rates', () => {
    // 1M in at $0.14 + 1M out at $0.28.
    expect(tokenCost(usage(1_000_000, 1_000_000), FLASH)).toBeCloseTo(0.42, 10)
  })

  it('bills cache reads as ordinary input, because the gateway does not discount them', () => {
    // The same fact that makes routing a cache-warm loop through this gateway
    // more expensive rather than less — so counting them as free would
    // understate the bill.
    expect(tokenCost(usage(0, 0, 1_000_000), FLASH)).toBeCloseTo(0.14, 10)
  })

  it('reports nothing rather than zero for an unpriced model', () => {
    // Zero would silently make an unpriced call look free in the total.
    expect(tokenCost(usage(1_000, 1_000), undefined)).toBeUndefined()
    expect(tokenCost(usage(1_000, 1_000), {})).toBeUndefined()
  })

  it('prices a free model as actually free', () => {
    expect(tokenCost(usage(1_000_000, 1_000_000), { input: 0, output: 0 })).toBe(0)
  })
})

describe('SpendMeter', () => {
  it('accumulates token cost and the flat per-request fee separately', () => {
    const meter = new SpendMeter(0.001)
    meter.record('deepseek/deepseek-chat', usage(1_000_000, 0), FLASH)
    meter.record('deepseek/deepseek-chat', usage(1_000_000, 0), FLASH)
    const summary = meter.summary()
    expect(summary.calls).toBe(2)
    expect(summary.tokenCostUsd).toBeCloseTo(0.28, 10)
    expect(summary.requestFeesUsd).toBeCloseTo(0.002, 10)
    expect(summary.totalUsd).toBeCloseTo(0.282, 10)
  })

  it('ranks models by what they actually cost', () => {
    const meter = new SpendMeter(0)
    meter.record('cheap', usage(1_000_000, 0), { input: 0.1 })
    meter.record('dear', usage(1_000_000, 0), { input: 5 })
    expect(meter.summary().byModel.map(entry => entry.model)).toEqual(['dear', 'cheap'])
  })

  it('counts an unpriced call and says so, rather than hiding it', () => {
    const meter = new SpendMeter(0.001)
    meter.record('mystery/model', usage(1_000, 1_000), undefined)
    const summary = meter.summary()
    // The call is still counted — it was still charged a fee — but its token
    // cost is missing, and a total that quietly omits calls is worse than one
    // that admits the gap.
    expect(summary.calls).toBe(1)
    expect(summary.unpricedCalls).toBe(1)
    expect(summary.requestFeesUsd).toBeCloseTo(0.001, 10)
    expect(renderSpend(summary)).toMatch(/publishes no rate/)
  })

  it('starts empty and says so', () => {
    expect(renderSpend(new SpendMeter(0.001).summary())).toMatch(/No BlockRun requests yet/)
  })

  it('renders small amounts legibly instead of rounding them to zero', () => {
    const meter = new SpendMeter(0.001)
    meter.record('deepseek/deepseek-chat', usage(1_000, 100), FLASH)
    const text = renderSpend(meter.summary())
    expect(text).not.toMatch(/\$0\.00\b/)
    expect(text).toMatch(/1 request/)
    // The figure is a floor, and the wallet is the authority — the output has
    // to say so rather than read like an invoice.
    expect(text).toMatch(/floor, not a settled invoice/)
  })
})

describe('projectRates', () => {
  it('reads published rates from the catalog shape the gateway returns', () => {
    const rates = projectRates({
      data: [
        { id: 'deepseek/deepseek-chat', pricing: { input: 0.14, output: 0.28 } },
        { id: 'free/model', pricing: { input: 0, output: 0 } },
        { id: 'unpriced/model' },
        { id: 'bad/model', pricing: { input: -1 } },
      ],
    })
    expect(rates.get('deepseek/deepseek-chat')).toEqual({ input: 0.14, output: 0.28 })
    expect(rates.get('free/model')).toEqual({ input: 0, output: 0 })
    expect(rates.has('unpriced/model')).toBe(false)
    expect(rates.has('bad/model')).toBe(false)
  })
})

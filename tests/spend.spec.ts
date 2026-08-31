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
  it('is unmoved by how much the model produced', () => {
    // Settlement follows the signed 402 quote, which is computed from the
    // request — input size plus the max_tokens asked for — so what the model
    // then produced cannot change the charge. Both calls below were quoted
    // identically; an earlier version of this test read that as proof of
    // per-request billing, which it is not. Per-token pricing is live above a
    // $0.002 floor; these two simply sit under it.
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
    expect(renderSpend(summary)).toMatch(/produced, not what was quoted/)
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
    expect(text).toMatch(/Quoted from the request/)
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

describe('the floor stops being honest as context grows', () => {
  it('says so when calls carry a large context', () => {
    const meter = new SpendMeter(0.002)
    // A coding agent's working context. The 402 quote at this size is ~$0.031,
    // fifteen times the floor — so a bare "$0.002" on screen would be the
    // misleading part, not the helpful one.
    meter.record('deepseek/deepseek-chat', usage(112_000, 200))
    const text = renderSpend(meter.summary())
    expect(text).toMatch(/FLOOR AND LIKELY WELL UNDER/)
    expect(text).toMatch(/112,000 input tokens per call/)
    // The spread is the point, not any one figure: at this size the same
    // prompt quotes $0.02 on gpt-4.1-nano and $1.08 on claude-opus-5, so a
    // single unattributed number is wrong for almost everyone reading it.
    expect(text).toMatch(/claude-opus-5/)
    expect(text).toMatch(/read your own model's rate/)
  })

  it('stays quiet for small calls, where the floor is exact', () => {
    const meter = new SpendMeter(0.002)
    // Measured: three calls this size moved a wallet by exactly $0.006.
    meter.record('deepseek/deepseek-chat', usage(17, 3))
    const text = renderSpend(meter.summary())
    expect(text).not.toMatch(/FLOOR AND LIKELY WELL UNDER/)
    expect(text).toMatch(/wallet balance is the authority/)
  })

  it('warns on the average, not on one big call among many', () => {
    const meter = new SpendMeter(0.002)
    meter.record('m', usage(112_000, 10))
    for (let i = 0; i < 400; i++) meter.record('m', usage(20, 10))
    // Average input is ~300 tokens, so the floor is still broadly right and
    // the warning would be noise.
    expect(renderSpend(meter.summary())).not.toMatch(/FLOOR AND LIKELY WELL UNDER/)
  })
})

describe('free-tier calls settle nothing, so they cost nothing', () => {
  // Measured 2026-08-30: the gateway answers a `billing_mode: "free"` model
  // with HTTP 200 and never opens an x402 handshake, so no quote is signed and
  // no USDC moves. Charging the flat request price for one invents a total out
  // of a wallet that was never touched — and the route now lists seven free
  // models, so this is not a corner case but the whole "try it before you fund
  // anything" path.
  const FREE = 'nvidia/nemotron-3.5-lightning'

  it('prices a free call at zero while still counting it', () => {
    const meter = new SpendMeter(PRICE)
    for (let i = 0; i < 5; i++) meter.record(FREE, usage(20, 40), true)
    const summary = meter.summary()
    expect(summary.totalUsd).toBe(0)
    expect(summary.calls).toBe(5)
    // The tokens are still carried: a free model's context still fills up, and
    // the reason to show a count is not that it became money.
    expect(summary.outputTokens).toBe(200)
  })

  it('charges only the paid calls when a session mixes both', () => {
    const meter = new SpendMeter(PRICE)
    meter.record(FREE, usage(20, 40), true)
    meter.record(FREE, usage(20, 40), true)
    meter.record('deepseek/deepseek-chat', usage(17, 3))
    const summary = meter.summary()
    expect(summary.calls).toBe(3)
    expect(summary.totalUsd).toBeCloseTo(PRICE, 10)
    expect(summary.byModel.find(entry => entry.model === FREE)?.costUsd).toBe(0)
    expect(summary.byModel.find(entry => entry.model === FREE)?.free).toBe(true)
    expect(summary.byModel.find(entry => entry.model === 'deepseek/deepseek-chat')?.free).toBeUndefined()
  })

  it('defaults to charging, so an uninstrumented caller cannot under-report', () => {
    const meter = new SpendMeter(PRICE)
    meter.record(FREE, usage(20, 40))
    expect(meter.summary().totalUsd).toBeCloseTo(PRICE, 10)
  })

  it('drops the free label once the same model is charged for', () => {
    // A model repriced mid-process keeps its real cost rather than showing a
    // partial total under a heading that says it was free.
    const meter = new SpendMeter(PRICE)
    meter.record(FREE, usage(20, 40), true)
    meter.record(FREE, usage(20, 40))
    const [entry] = meter.summary().byModel
    expect(entry?.free).toBeUndefined()
    expect(entry?.costUsd).toBeCloseTo(PRICE, 10)
  })

  it('says a $0 row is really free rather than leaving it to be read as a bug', () => {
    const meter = new SpendMeter(PRICE)
    meter.record(FREE, usage(20, 40), true)
    const text = renderSpend(meter.summary())
    expect(text).toMatch(/no payment was signed/)
    expect(text).toMatch(/nothing was quoted and nothing settled/)
    // The quote explanation describes a handshake that never happened here.
    expect(text).not.toMatch(/Quoted from the request/)
  })

  it('does not warn about a climbing quote for calls that were never quoted', () => {
    // The large-context warning is about how a 402 quote grows with input. A
    // free call has no quote, so firing it would tell a reader who owes
    // nothing that their total is "well under the real charge".
    const meter = new SpendMeter(PRICE)
    meter.record(FREE, usage(112_000, 200), true)
    const text = renderSpend(meter.summary())
    expect(text).not.toMatch(/FLOOR AND LIKELY WELL UNDER/)
    expect(text).toMatch(/\$0\b/)
  })

  it('still warns when the paid half of a session carries a large context', () => {
    const meter = new SpendMeter(PRICE)
    for (let i = 0; i < 50; i++) meter.record(FREE, usage(20, 10), true)
    meter.record('anthropic/claude-opus-5', usage(112_000, 200))
    // Averaged over the paid calls alone. Diluting it with fifty free ones
    // would silence a warning about a call that really did quote ~$1.08.
    expect(renderSpend(meter.summary())).toMatch(/FLOOR AND LIKELY WELL UNDER/)
  })
})

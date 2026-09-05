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
    expect(text).toMatch(/quoted from the request/)
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
    expect(text).toMatch(/nothing was quoted, nothing settled/)
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

describe('a substituted model is named, not hidden', () => {
  // The gateway answers some requests with a different model than the one
  // asked for — the free-tier cascade picking a live rung, the free-model
  // health gate rerouting around a dead one, and MODEL_REDIRECTS rewriting a
  // retired id. Measured 2026-08-30: six consecutive streamed requests for
  // nvidia/nemotron-3-nano-omni-30b-a3b-reasoning were answered by
  // nvidia/nemotron-3-nano-30b, which carries no vision tag at all.
  const ASKED = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'
  const SERVED = 'nvidia/nemotron-3-nano-30b'

  it('counts the call against the model that was requested', () => {
    // Not against the one that answered. A row that renamed itself would look
    // like a model nobody selected appearing out of nowhere, and the reader
    // would have no way back to the id they actually pinned.
    const meter = new SpendMeter(PRICE)
    meter.record(ASKED, usage(10, 5), true, SERVED)
    const [entry] = meter.summary().byModel
    expect(entry?.model).toBe(ASKED)
    expect(entry?.calls).toBe(1)
  })

  it('records which model answered, and how often', () => {
    const meter = new SpendMeter(PRICE)
    for (let i = 0; i < 6; i++) meter.record(ASKED, usage(10, 5), true, SERVED)
    expect(meter.summary().byModel[0]?.servedBy).toEqual({ [SERVED]: 6 })
  })

  it('says nothing when the model that answered is the one that was asked', () => {
    // The adapter passes the served id through unconditionally, so the "no
    // substitution" case has to be silent here rather than at the call site.
    const meter = new SpendMeter(PRICE)
    meter.record(ASKED, usage(10, 5), true, ASKED)
    expect(meter.summary().byModel[0]?.servedBy).toBeUndefined()
  })

  it('keeps substitutions apart when more than one model stood in', () => {
    const meter = new SpendMeter(PRICE)
    meter.record(ASKED, usage(10, 5), true, SERVED)
    meter.record(ASKED, usage(10, 5), true, 'nvidia/nemotron-3.5-lightning')
    meter.record(ASKED, usage(10, 5), true, SERVED)
    expect(meter.summary().byModel[0]?.servedBy)
      .toEqual({ [SERVED]: 2, 'nvidia/nemotron-3.5-lightning': 1 })
  })

  it('prints the substitution under the row it belongs to', () => {
    const meter = new SpendMeter(PRICE)
    for (let i = 0; i < 6; i++) meter.record(ASKED, usage(10, 5), true, SERVED)
    const text = renderSpend(meter.summary())
    expect(text).toMatch(new RegExp(`answered by ${SERVED} on 6 of 6`))
    expect(text).toMatch(/gateway substituted a different model/)
    // The row itself still leads with the id the reader chose.
    expect(text).toMatch(new RegExp(`  ${ASKED}  \\$0  6 calls`))
  })

  it('leaves an ordinary row alone', () => {
    const meter = new SpendMeter(PRICE)
    meter.record('deepseek/deepseek-chat', usage(17, 3))
    expect(renderSpend(meter.summary())).not.toMatch(/answered by/)
  })
})

describe('account billing is priced from tokens, not from a per-request quote', () => {
  // The flat figure is a property of the x402 quote and of nothing else.
  // api.blockrun.ai bills the account post-hoc at ACTUAL usage against the
  // published sheet — no per-call fee, no minimum — so charging $0.002 a call
  // there would report several times what the account is invoiced for a
  // session of small calls, which is the exact number a customer disputes.
  const rates = { input: 5, output: 30 }
  const account = { kind: 'per-token', rates } as const

  it('multiplies the reported tokens by the published per-million rates', () => {
    const meter = new SpendMeter(0.002)
    meter.record('openai/gpt-5.5', usage(16, 17), false, undefined, account)
    // 16/1e6 * $5 + 17/1e6 * $30 — measured against the live account host,
    // which billed this exact call.
    expect(meter.summary().totalUsd).toBeCloseTo(0.00059, 10)
    expect(meter.summary().basis).toBe('per-token')
  })

  it('does not charge the per-request fee on top, because the account has none', () => {
    const meter = new SpendMeter(0.002)
    meter.record('openai/gpt-5.5', usage(16, 17), false, undefined, account)
    expect(meter.summary().totalUsd).toBeLessThan(0.002)
  })

  it('folds cached input back in, because that is what the invoice prices', () => {
    // This route speaks the OpenAI protocol, where `prompt_tokens` is
    // cache-inclusive and the account meter prices the whole of it at the
    // input rate. `translate.ts` splits the cached part out for the harness's
    // disjoint buckets; dropping it here would under-bill every cached turn.
    const meter = new SpendMeter(0.002)
    meter.record('openai/gpt-5.5', usage(10, 0, 90), false, undefined, account)
    expect(meter.summary().totalUsd).toBeCloseTo((100 / 1e6) * 5, 12)
  })

  it('counts a model the catalog does not price as unpriced, never as free', () => {
    // Zero would read as "this cost nothing", which is the one thing it does
    // not mean. The row says the figure is short and by how many calls.
    const meter = new SpendMeter(0.002)
    meter.record('vendor/unlisted', usage(1000, 1000), false, undefined, { kind: 'per-token' })
    const summary = meter.summary()
    expect(summary.totalUsd).toBe(0)
    expect(summary.byModel[0]?.free).toBeUndefined()
    expect(summary.byModel[0]?.unpricedCalls).toBe(1)
    expect(renderSpend(summary)).toMatch(/NOT in the figure above/)
  })

  it('still costs nothing for a free model, whichever scheme is in force', () => {
    const meter = new SpendMeter(0.002)
    meter.record('nvidia/nemotron-3.5-lightning', usage(20, 5), true, undefined, account)
    expect(meter.summary().totalUsd).toBe(0)
    expect(meter.summary().byModel[0]?.free).toBe(true)
  })

  it('points at the account ledger rather than at a wallet balance', () => {
    const meter = new SpendMeter(0.002)
    meter.record('openai/gpt-5.5', usage(16, 17), false, undefined, account)
    const text = renderSpend(meter.summary())
    expect(text).toMatch(/user\.blockrun\.ai\/dashboard is the authority/)
    expect(text).not.toMatch(/wallet balance/)
  })

  it('never calls an exact figure a floor, however long the context', () => {
    // The floor warning belongs to the quote, and an account call has none:
    // it is invoiced from the very counts printed above it.
    const meter = new SpendMeter(0.002)
    meter.record('openai/gpt-5.5', usage(112_000, 500), false, undefined, account)
    expect(renderSpend(meter.summary())).not.toMatch(/THIS TOTAL IS A FLOOR/)
  })

  it('describes both schemes when a key was added mid-session', () => {
    // A deployment can legitimately switch: the earlier calls really did
    // settle a quote, and saying so is the only way the total adds up.
    const meter = new SpendMeter(0.002)
    meter.record('deepseek/deepseek-chat', usage(14, 1))
    meter.record('openai/gpt-5.5', usage(16, 17), false, undefined, account)
    const summary = meter.summary()
    expect(summary.basis).toBe('mixed')
    expect(summary.totalUsd).toBeCloseTo(0.002 + 0.00059, 10)
    const text = renderSpend(summary)
    expect(text).toMatch(/API key \(account billing\)/)
    expect(text).toMatch(/Wallet \(x402\)/)
  })

  it('leaves an unconfigured caller on the wallet scheme, so nothing under-reports', () => {
    const meter = new SpendMeter(0.002)
    meter.record('deepseek/deepseek-chat', usage(14, 1))
    expect(meter.summary().basis).toBe('per-request')
    expect(meter.summary().totalUsd).toBe(0.002)
  })
})

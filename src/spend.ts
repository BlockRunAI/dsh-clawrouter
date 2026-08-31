/**
 * What this route has spent, computed from the same numbers BlockRun bills on.
 *
 * Money here is `paid calls x per-request price`, and NOT a token calculation.
 * Free-tier calls are counted and priced at zero: the gateway serves a
 * `billing_mode: "free"` model with no x402 handshake at all, so there is no
 * quote to settle.
 *
 * What settles on chain is the signed 402 quote, and settlement is independent
 * of what the model then does. Measured against the wallet: three calls capped
 * at 24 tokens cost $0.006, three capped at 4096 cost $0.006, and one that
 * generated 8,000 output tokens cost $0.002 — the same per call every time.
 * Pricing the last one from its tokens gave $0.004243, overstating the real
 * charge by more than double.
 *
 * So token counts are carried as counts, never converted into money. The
 * result is exact for ordinary calls and a FLOOR for very large inputs, whose
 * quote is higher than the per-request price; it also cannot see a request
 * that failed after its payment settled. Reporting the quote itself would be
 * exact in every case, and needs the SDK to expose it.
 *
 * It lives in memory for the life of the process. A durable per-session figure
 * would need a session event, which a plugin outside the harness repository
 * cannot write.
 *
 * @module dsh-clawrouter/spend
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/**
 * Per-million-token rates as the catalog publishes them.
 *
 * Kept because the catalog states them and a selector may want to show them.
 * They are deliberately NOT used to compute what a call cost: settlement
 * follows the per-request quote, and pricing a call from its tokens was
 * measured overstating a real charge by more than double.
 */
export interface ModelRates {
  /** USD per million input tokens. */
  input?: number
  /** USD per million output tokens. */
  output?: number
}

/** What one model has been called for so far. */
export interface ModelSpend {
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  /** `paid calls x` the per-request price. Token counts do not enter this. */
  costUsd: number
  /**
   * Set when every call to this model was served free of charge.
   *
   * A free row is a `$0` that means it, and saying so is the point: a bare
   * `$0` beside a model name reads as a rounding artifact or a bug, which is
   * exactly the doubt that makes a total worth nothing.
   */
  free?: boolean
}

/** A model's running totals, plus the paid-call count `costUsd` is computed from. */
interface Tally extends ModelSpend {
  /** Calls that actually settled on chain; free-tier calls are excluded. */
  paidCalls: number
}

/** Input size past which the per-request floor stops resembling the real charge. */
export const FLOOR_RELIABLE_INPUT_TOKENS = 1_000

/** Everything the meter knows. */
export interface SpendSummary {
  calls: number
  /** Carried for context only; deliberately not priced. */
  inputTokens: number
  /** Carried for context only; deliberately not priced. */
  outputTokens: number
  totalUsd: number
  /** Busiest first. */
  byModel: ModelSpend[]
}

/** Accumulates what one provider route has been charged. */
export class SpendMeter {
  readonly #models = new Map<string, Tally>()

  /** @param requestPriceUsd - what one request costs on this deployment. */
  constructor(private readonly requestPriceUsd: number) {}

  /**
   * Count one completed call.
   *
   * A free-tier call is counted and priced at nothing, because nothing is what
   * it costs: the gateway answers a `billing_mode: "free"` model with HTTP 200
   * and never opens an x402 handshake, so no quote is signed and no USDC
   * moves. Charging the flat request price for one would invent a total out of
   * a wallet that was never touched — and the catalog billed seven of seventy
   * chat models as free on 2026-08-30, so a session spent trying them out
   * would report a cost that is entirely fictional.
   *
   * @param model - the model that served it.
   * @param usage - reported token counts, carried for context only.
   * @param free - whether the gateway served this call without payment.
   */
  record(model: string, usage: TokenUsage, free = false): void {
    const entry = this.#models.get(model)
      ?? { model, calls: 0, paidCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
    entry.calls += 1
    if (!free) entry.paidCalls += 1
    entry.inputTokens += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    entry.outputTokens += usage.outputTokens
    entry.costUsd = entry.paidCalls * this.requestPriceUsd
    this.#models.set(model, entry)
  }

  /**
   * Everything counted so far.
   * @returns a detached summary, busiest model first.
   */
  summary(): SpendSummary {
    const byModel = [...this.#models.values()]
      .sort((left, right) => right.calls - left.calls)
      .map(({ model, calls, inputTokens, outputTokens, costUsd, paidCalls }) => ({
        model,
        calls,
        inputTokens,
        outputTokens,
        costUsd,
        // Claimed only for a model that has never once been charged for. A
        // model repriced mid-process keeps its real cost and loses the label,
        // rather than showing a partial total under a "free" heading.
        ...paidCalls === 0 ? { free: true } : {},
      }))
    return {
      calls: byModel.reduce((sum, entry) => sum + entry.calls, 0),
      inputTokens: byModel.reduce((sum, entry) => sum + entry.inputTokens, 0),
      outputTokens: byModel.reduce((sum, entry) => sum + entry.outputTokens, 0),
      // Summed from the rows rather than from the call count, so the total and
      // the rows under it cannot disagree once some of those rows are free.
      totalUsd: byModel.reduce((sum, entry) => sum + entry.costUsd, 0),
      byModel,
    }
  }
}

/** USD to a fixed number of decimals, small values kept legible rather than rounded to zero. */
function usd(value: number): string {
  if (value === 0) return '$0'
  return value < 0.01 ? `$${value.toFixed(6)}` : `$${value.toFixed(4)}`
}

/**
 * Render a summary for a human.
 * @param summary - the meter's current totals.
 * @returns the text a `/spend` invocation prints.
 */
export function renderSpend(summary: SpendSummary): string {
  if (summary.calls === 0) return 'No BlockRun requests yet in this process.'
  const lines = [
    `${usd(summary.totalUsd)} across ${summary.calls} request${summary.calls === 1 ? '' : 's'}`,
    `  ${summary.inputTokens.toLocaleString()} tokens in / ${summary.outputTokens.toLocaleString()} out (produced, not what was quoted)`,
    '',
  ]
  for (const entry of summary.byModel) {
    lines.push(
      `  ${entry.model}  ${usd(entry.costUsd)}  ${entry.calls} call${entry.calls === 1 ? '' : 's'}`
      + (entry.free === true ? '  (free tier — no payment was signed)' : ''),
    )
  }
  // Everything below describes how a quote is formed, and a free call has no
  // quote. Read across all calls, a session that mostly used the free tier
  // would report an average input size that no charge was ever computed from —
  // and could trip the large-context warning while owing nothing at all.
  const paid = summary.byModel.filter(entry => entry.free !== true)
  const paidCalls = paid.reduce((sum, entry) => sum + entry.calls, 0)
  const averageInput = paidCalls === 0 ? 0 : paid.reduce((sum, entry) => sum + entry.inputTokens, 0) / paidCalls
  lines.push(
    '',
    paidCalls === 0
      ? 'Every call so far went to a free model: the gateway answers those with no x402 handshake, so nothing was quoted and nothing settled.'
      : 'Quoted from the request — input size plus the max_tokens asked for — and settled at that amount whichever way the model answers.'
        + ' These counts are what was produced, so they cannot reconstruct the charge.',
  )
  if (averageInput > FLOOR_RELIABLE_INPUT_TOKENS) {
    // Silence here would be the misleading part. The quote climbs with input,
    // so on a long context this total is not slightly low, it is a different
    // order of magnitude.
    lines.push(
      `THIS TOTAL IS A FLOOR AND LIKELY WELL UNDER THE REAL CHARGE: averaging ${Math.round(averageInput).toLocaleString()} input tokens per call, `
      + 'and the request price climbs with both context and the model. Measured at ~112K input tokens, one call quotes about '
      + '$0.02 on gpt-4.1-nano, $0.03 on deepseek-chat, $0.33 on gemini-3.5-flash and $1.08 on claude-opus-5 — so read your own '
      + "model's rate rather than any single number here.",
    )
  }
  lines.push('Only completed calls are counted. Your wallet balance is the authority.')
  return lines.join('\n')
}

/**
 * What this route has spent, computed from the same numbers BlockRun bills on.
 *
 * Money here is `calls x per-request price`, and NOT a token calculation.
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
  /** `calls x` the per-request price. Token counts do not enter this. */
  costUsd: number
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
  readonly #models = new Map<string, ModelSpend>()

  /** @param requestPriceUsd - what one request costs on this deployment. */
  constructor(private readonly requestPriceUsd: number) {}

  /**
   * Count one completed call.
   * @param model - the model that served it.
   * @param usage - reported token counts, carried for context only.
   */
  record(model: string, usage: TokenUsage): void {
    const entry = this.#models.get(model) ?? { model, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
    entry.calls += 1
    entry.inputTokens += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    entry.outputTokens += usage.outputTokens
    entry.costUsd = entry.calls * this.requestPriceUsd
    this.#models.set(model, entry)
  }

  /**
   * Everything counted so far.
   * @returns a detached summary, busiest model first.
   */
  summary(): SpendSummary {
    const byModel = [...this.#models.values()]
      .map(entry => ({ ...entry }))
      .sort((left, right) => right.calls - left.calls)
    const calls = byModel.reduce((sum, entry) => sum + entry.calls, 0)
    return {
      calls,
      inputTokens: byModel.reduce((sum, entry) => sum + entry.inputTokens, 0),
      outputTokens: byModel.reduce((sum, entry) => sum + entry.outputTokens, 0),
      totalUsd: calls * this.requestPriceUsd,
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
    `  ${summary.inputTokens.toLocaleString()} tokens in / ${summary.outputTokens.toLocaleString()} out (not billed by token)`,
    '',
  ]
  for (const entry of summary.byModel) {
    lines.push(`  ${entry.model}  ${usd(entry.costUsd)}  ${entry.calls} call${entry.calls === 1 ? '' : 's'}`)
  }
  const averageInput = summary.calls === 0 ? 0 : summary.inputTokens / summary.calls
  lines.push(
    '',
    'Priced per request, not per token: measured against the wallet, a call generating 8,000 output tokens cost the same as one generating 3.',
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

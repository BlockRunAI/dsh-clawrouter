/**
 * What this route has spent, computed from the same numbers BlockRun bills on.
 *
 * This is a FLOOR, and deliberately described as one everywhere it is shown.
 *
 * What settles on chain is the signed 402 quote, and the gateway computes that
 * quote from the estimated input plus `max_tokens` — the cap, not the tokens
 * the model went on to produce. A request capped at 4096 that answers in 50 is
 * charged for far more than it used. This counts actual reported usage, so it
 * reads low by exactly that gap, and it cannot see a request that failed after
 * its payment settled either.
 *
 * It is still worth showing: the flat fee dominates small calls, the token
 * rates are the published ones, and a floor with its limits stated beats an
 * agent spending a wallet with no figure anywhere.
 *
 * It lives in memory for the life of the process. A durable per-session figure
 * would need a session event, which a plugin outside the harness repository
 * cannot write.
 *
 * @module dsh-clawrouter/spend
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** Per-million-token rates for one model, as the catalog publishes them. */
export interface ModelRates {
  /** USD per million input tokens. */
  input?: number
  /** USD per million output tokens. */
  output?: number
}

/** What one model has cost so far. */
export interface ModelSpend {
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  /** Token cost only; the per-request fee is reported separately. */
  tokenCostUsd: number
}

/** Everything the meter knows. */
export interface SpendSummary {
  calls: number
  inputTokens: number
  outputTokens: number
  tokenCostUsd: number
  /** Flat per-request fees across every counted call. */
  requestFeesUsd: number
  totalUsd: number
  /** Most expensive first. */
  byModel: ModelSpend[]
  /**
   * Calls whose model carried no published rate, so their token cost is
   * missing from the totals. Reported rather than hidden: a total that quietly
   * omits calls is worse than one that says how much it is missing.
   */
  unpricedCalls: number
}

/**
 * Token cost for one call.
 *
 * Cache reads are billed as ordinary input here because the gateway does not
 * discount them — the same fact that makes routing a cache-warm loop through
 * this gateway more expensive, not less.
 * @param usage - the provider's reported token counts.
 * @param rates - published per-million rates, when the catalog has them.
 * @returns the cost in USD, or undefined when no rate is published.
 */
export function tokenCost(usage: TokenUsage, rates: ModelRates | undefined): number | undefined {
  const input = rates?.input
  const output = rates?.output
  if (input === undefined && output === undefined) return undefined
  const billedInput = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  return (billedInput * (input ?? 0) + usage.outputTokens * (output ?? 0)) / 1_000_000
}

/** Accumulates spend for one provider route. */
export class SpendMeter {
  readonly #models = new Map<string, ModelSpend>()
  #unpriced = 0

  /** @param requestFeeUsd - flat per-request fee this deployment is charged. */
  constructor(private readonly requestFeeUsd: number) {}

  /**
   * Count one completed call.
   * @param model - the model that served it.
   * @param usage - the provider's reported token counts.
   * @param rates - published per-million rates, when known.
   */
  record(model: string, usage: TokenUsage, rates: ModelRates | undefined): void {
    const cost = tokenCost(usage, rates)
    if (cost === undefined) this.#unpriced += 1
    const entry = this.#models.get(model) ?? { model, calls: 0, inputTokens: 0, outputTokens: 0, tokenCostUsd: 0 }
    entry.calls += 1
    entry.inputTokens += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    entry.outputTokens += usage.outputTokens
    entry.tokenCostUsd += cost ?? 0
    this.#models.set(model, entry)
  }

  /**
   * Everything counted so far.
   * @returns a detached summary, most expensive model first.
   */
  summary(): SpendSummary {
    const byModel = [...this.#models.values()]
      .map(entry => ({ ...entry }))
      .sort((left, right) => right.tokenCostUsd - left.tokenCostUsd)
    const calls = byModel.reduce((sum, entry) => sum + entry.calls, 0)
    const tokenCostUsd = byModel.reduce((sum, entry) => sum + entry.tokenCostUsd, 0)
    const requestFeesUsd = calls * this.requestFeeUsd
    return {
      calls,
      inputTokens: byModel.reduce((sum, entry) => sum + entry.inputTokens, 0),
      outputTokens: byModel.reduce((sum, entry) => sum + entry.outputTokens, 0),
      tokenCostUsd,
      requestFeesUsd,
      totalUsd: tokenCostUsd + requestFeesUsd,
      byModel,
      unpricedCalls: this.#unpriced,
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
    `  tokens  ${usd(summary.tokenCostUsd)}  (${summary.inputTokens.toLocaleString()} in / ${summary.outputTokens.toLocaleString()} out)`,
    `  fees    ${usd(summary.requestFeesUsd)}  (flat per-request)`,
    '',
  ]
  for (const entry of summary.byModel) {
    lines.push(`  ${entry.model}  ${usd(entry.tokenCostUsd)}  ${entry.calls} call${entry.calls === 1 ? '' : 's'}`)
  }
  if (summary.unpricedCalls > 0) {
    lines.push('', `${summary.unpricedCalls} call(s) ran on a model the catalog publishes no rate for; their token cost is not included.`)
  }
  lines.push(
    '',
    'A floor, not an invoice: what settles is the signed 402 quote, which is priced on max_tokens rather than the tokens actually produced, and only completed calls are counted. Your wallet balance is the authority.',
  )
  return lines.join('\n')
}

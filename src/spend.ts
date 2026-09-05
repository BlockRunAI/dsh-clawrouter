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
 * An API-key deployment is billed on a different basis entirely, so it is
 * counted on a different one: `api.blockrun.ai` meters ACTUAL token usage
 * against the published price sheet, with no per-call minimum and no per-call
 * fee. There the flat figure above is not a floor, it is a fiction — a session
 * of small calls would be reported at several times what the account is
 * invoiced. So an account-billed call is priced from its own tokens and the
 * catalog's own rates, which is the arithmetic the ledger behind
 * `user.blockrun.ai/dashboard` performs. See {@link CallPricing}.
 *
 * It lives in memory for the life of the process. A durable per-session figure
 * would need a session event, which a plugin outside the harness repository
 * cannot write.
 *
 * @module dsh-clawrouter/spend
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { PORTAL_URL } from './auth.ts'

/**
 * Per-million-token rates as the catalog publishes them.
 *
 * These price an ACCOUNT-billed call and nothing else. On the wallet path they
 * are carried for display only: settlement there follows the per-request
 * quote, and pricing such a call from its tokens was measured overstating a
 * real charge by more than double.
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
  /**
   * What this model has cost.
   *
   * On the wallet path that is `paid calls x` the per-request price, and token
   * counts do not enter it. On the account path it is the tokens themselves,
   * at the catalog's published rates.
   */
  costUsd: number
  /**
   * Account-billed calls the catalog published no rate for, and which are
   * therefore missing from `costUsd`.
   *
   * Reported rather than absorbed: a total that quietly counts an unpriceable
   * call as zero is wrong in the direction that costs the reader money, and a
   * model the sheet does not price is exactly the one worth looking up.
   */
  unpricedCalls?: number
  /**
   * Set when every call to this model was served free of charge.
   *
   * A free row is a `$0` that means it, and saying so is the point: a bare
   * `$0` beside a model name reads as a rounding artifact or a bug, which is
   * exactly the doubt that makes a total worth nothing.
   */
  free?: boolean
  /**
   * Calls the gateway answered with a DIFFERENT model, counted by that
   * model's id. Absent when every call was served by the model requested.
   *
   * Recorded against the model that was asked for, not the one that answered,
   * because that is the id the reader chose and would recognize. The
   * substitution is then named beside it rather than replacing it, which is
   * the only form in which it is actually useful: a row that silently renamed
   * itself would look like a model nobody selected appearing from nowhere.
   */
  servedBy?: Record<string, number>
}

/** A model's running totals, plus the counters `costUsd` is computed from. */
interface Tally extends ModelSpend {
  /** Calls that cost money under either scheme; free-tier calls are excluded. */
  paidCalls: number
  /** Paid calls priced at the flat per-request quote — the wallet paths. */
  flatCalls: number
  /** Their summed quotes, which are not `flatCalls x` one number: see {@link CallPricing}. */
  flatCostUsd: number
  /** Account-billed cost accumulated from tokens x published rates. */
  tokenCostUsd: number
  /** Substitutions by served model id, accumulated in place. */
  substitutions: Map<string, number>
}

/**
 * How one call is charged.
 *
 * The two schemes are not variations on a number, they are different
 * questions: a wallet call settles a quote struck before the model answered,
 * and an account call is invoiced from what the model actually produced. A
 * meter that averaged them would be wrong under both.
 */
export type CallPricing =
  /**
   * x402: the flat per-request quote, settled whatever the model then does.
   * @remarks `feeUsd` is the quote for the chain this call settles on — Base
   * and Solana are quoted differently for the same request, so a meter holding
   * one figure is wrong on one of them. Absent falls back to the meter's own
   * default, which is what an older caller passing no fee gets.
   */
  | { readonly kind: 'per-request'; readonly feeUsd?: number }
  /**
   * Account billing at exact usage.
   * @remarks `rates` absent means the catalog published none for this model,
   * which is counted as unpriced rather than as free.
   */
  | { readonly kind: 'per-token'; readonly rates?: ModelRates }

/** The wallet path's scheme, and the default for every caller that names none. */
const PER_REQUEST: CallPricing = { kind: 'per-request' }

/** Input size past which the per-request floor stops resembling the real charge. */
export const FLOOR_RELIABLE_INPUT_TOKENS = 1_000

/**
 * Which scheme (or schemes) the counted calls were charged under.
 *
 * Carried because the sentence under a total is not decoration — it says what
 * the number is and is not, and the two schemes need opposite warnings. A
 * deployment can legitimately be `mixed`: an API key added mid-session moves
 * later calls onto account billing without unwinding the earlier ones.
 */
export type SpendBasis = 'per-request' | 'per-token' | 'mixed' | 'none'

/** Everything the meter knows. */
export interface SpendSummary {
  calls: number
  /** The scheme behind `totalUsd`; `none` when nothing has been charged yet. */
  basis: SpendBasis
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
   * @param model - the model that was requested.
   * @param usage - reported token counts, carried for context only.
   * @param free - whether the gateway served this call without payment.
   * @param servedModel - the model that actually answered, when the gateway
   *   substituted a different one. Counted, never charged separately: this
   *   meter prices a call at a flat per-request figure, so which row it lands
   *   on does not move the total, and the requested id is the one the reader
   *   picked.
   */
  record(
    model: string,
    usage: TokenUsage,
    free = false,
    servedModel?: string,
    pricing: CallPricing = PER_REQUEST,
  ): void {
    const entry: Tally = this.#models.get(model) ?? {
      model,
      calls: 0,
      paidCalls: 0,
      flatCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      flatCostUsd: 0,
      tokenCostUsd: 0,
      substitutions: new Map(),
    }
    entry.calls += 1
    if (servedModel !== undefined && servedModel !== model) {
      entry.substitutions.set(servedModel, (entry.substitutions.get(servedModel) ?? 0) + 1)
    }
    // Summed back into one figure because that is what the account is billed
    // on: this route speaks the OpenAI protocol, where `prompt_tokens` is
    // cache-INCLUSIVE and the meter behind api.blockrun.ai prices the whole of
    // it at the input rate. `translate.ts` splits the cached part out for the
    // harness's disjoint buckets, so re-adding it here restores the number the
    // invoice is computed from rather than inventing a second one.
    const input = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    entry.inputTokens += input
    entry.outputTokens += usage.outputTokens
    if (!free) {
      entry.paidCalls += 1
      if (pricing.kind === 'per-request') {
        entry.flatCalls += 1
        entry.flatCostUsd += pricing.feeUsd ?? this.requestPriceUsd
      } else if (pricing.rates === undefined) {
        // Counted, never guessed. Zero would read as free and any invented
        // rate would read as fact.
        entry.unpricedCalls = (entry.unpricedCalls ?? 0) + 1
      } else {
        entry.tokenCostUsd += (input / 1e6) * (pricing.rates.input ?? 0)
          + (usage.outputTokens / 1e6) * (pricing.rates.output ?? 0)
      }
    }
    entry.costUsd = entry.flatCostUsd + entry.tokenCostUsd
    this.#models.set(model, entry)
  }

  /**
   * Everything counted so far.
   * @returns a detached summary, busiest model first.
   */
  summary(): SpendSummary {
    const tallies = [...this.#models.values()].sort((left, right) => right.calls - left.calls)
    const byModel = tallies.map((
      { model, calls, inputTokens, outputTokens, costUsd, paidCalls, substitutions, unpricedCalls },
    ) => ({
      model,
      calls,
      inputTokens,
      outputTokens,
      costUsd,
      // Claimed only for a model that has never once been charged for. A
      // model repriced mid-process keeps its real cost and loses the label,
      // rather than showing a partial total under a "free" heading.
      ...paidCalls === 0 ? { free: true } : {},
      ...unpricedCalls === undefined ? {} : { unpricedCalls },
      ...substitutions.size === 0 ? {} : { servedBy: Object.fromEntries(substitutions) },
    }))
    // Read off the counters rather than off configuration, so a key added
    // mid-session is described as what it did rather than as what the plugin
    // is currently set to.
    const flat = tallies.some(entry => entry.flatCalls > 0)
    const metered = tallies.some(entry => entry.tokenCostUsd > 0 || entry.unpricedCalls !== undefined)
    return {
      calls: byModel.reduce((sum, entry) => sum + entry.calls, 0),
      basis: flat && metered ? 'mixed' : flat ? 'per-request' : metered ? 'per-token' : 'none',
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
    if (entry.unpricedCalls !== undefined) {
      lines.push(
        `      ${entry.unpricedCalls} of these are NOT in the figure above — the catalog published no`
        + ' per-token rate for this model, and a price nobody published is not one to invent.',
      )
    }
    // Printed under the row rather than folded into it, because it is not a
    // detail of the cost — it says the answer came from somewhere else, which
    // is a fact about the reply rather than about the bill.
    for (const [served, count] of Object.entries(entry.servedBy ?? {})) {
      lines.push(`      answered by ${served} on ${count} of ${entry.calls} — the gateway substituted a different model`)
    }
  }
  // Everything below describes how a quote is formed, and a free call has no
  // quote. Read across all calls, a session that mostly used the free tier
  // would report an average input size that no charge was ever computed from —
  // and could trip the large-context warning while owing nothing at all.
  const paid = summary.byModel.filter(entry => entry.free !== true)
  const paidCalls = paid.reduce((sum, entry) => sum + entry.calls, 0)
  const averageInput = paidCalls === 0 ? 0 : paid.reduce((sum, entry) => sum + entry.inputTokens, 0) / paidCalls
  lines.push('', ...basisNotes(summary.basis, paidCalls))
  // The floor warning belongs to the quote, and an account-billed call has no
  // quote — it is invoiced from the very counts printed above. Printing it
  // there would warn a reader off a number that is exact.
  if (summary.basis !== 'per-token' && averageInput > FLOOR_RELIABLE_INPUT_TOKENS) {
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
  lines.push(
    'Only completed calls are counted. '
    + (summary.basis === 'per-token'
      ? `Your account ledger at ${PORTAL_URL}/dashboard is the authority.`
      : 'Your wallet balance is the authority.'),
  )
  return lines.join('\n')
}

/**
 * The sentences that say what the total above actually is.
 *
 * Split out because the two schemes need opposite ones and a deployment can be
 * on both: the wallet total is a floor derived from quotes, the account total
 * is the same arithmetic the invoice uses. Saying either about the other is
 * the kind of wrong that ends in a surprised customer.
 * @param basis - which scheme(s) the counted calls settled under.
 * @param paidCalls - calls that cost anything at all.
 * @returns one line per applicable scheme.
 */
function basisNotes(basis: SpendBasis, paidCalls: number): string[] {
  if (paidCalls === 0) {
    return [
      'Every call so far went to a free model: nothing was quoted, nothing settled, and nothing is owed.',
    ]
  }
  const notes: string[] = []
  if (basis === 'per-token' || basis === 'mixed') {
    notes.push(
      'API key (account billing): priced from the tokens the provider reported, at the catalog\'s published'
      + ' per-million rates — the same basis your account is invoiced on, with no per-call fee and no minimum.',
    )
  }
  if (basis === 'per-request' || basis === 'mixed') {
    notes.push(
      'Wallet (x402): quoted from the request — input size plus the max_tokens asked for — and settled at that'
      + ' amount whichever way the model answers. These counts are what was produced, so they cannot'
      + ' reconstruct the charge.',
    )
  }
  return notes
}

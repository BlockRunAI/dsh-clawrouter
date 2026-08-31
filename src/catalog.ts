/**
 * BlockRun model catalog: one cached read of `GET /api/v1/models` projected
 * onto the harness `LlmModelInfo` / `LlmResolvedModelInfo` vocabulary.
 *
 * The catalog is fetched rather than hardcoded because BlockRun's model list
 * changes far faster than this plugin releases, and the repository that owns
 * the prices forbids quoting them from memory. A stale-but-served cache keeps
 * a transient gateway failure from emptying a selector that was populated a
 * moment ago.
 *
 * @module dsh-clawrouter/catalog
 */

import type { LlmModelInfo, LlmResolvedModelInfo, ModelModality, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { BlockrunCatalogModel } from './types.ts'
import type { ModelRates } from './spend.ts'

/** How long a successful catalog read is reused before the next fetch. */
export const CATALOG_TTL_MS = 300_000

/** Deadline for one catalog request; it is shared, so it cannot wait forever. */
export const CATALOG_FETCH_TIMEOUT_MS = 15_000

/**
 * Capacity assumed for a model the catalog does not size. A guess by
 * construction: BlockRun serves models whose context the listing sometimes
 * omits, and refusing them outright would hide a usable model, while this
 * value only affects capacity display and compaction pressure.
 */
export const DEFAULT_CONTEXT_WINDOW = 131_072

/** Output capability assumed for a model the catalog does not size. */
export const DEFAULT_MAX_TOKENS = 8_192

/**
 * Ceiling applied to a model's advertised `max_output` when choosing the
 * default output cap.
 *
 * This gateway quotes on the max_tokens you REQUEST, not the tokens the model
 * returns, and settles the quoted amount. Declaring a model's full `max_output`
 * as the default therefore bills every unspecified call for output nobody
 * asked for. Measured on `anthropic/claude-opus-5`: a request capped at its
 * advertised 128,000 quotes $0.3211, against $0.0216 with no cap at all and
 * $0.0036 capped at 1,000 — an 89-fold difference decided by a field the
 * caller never set.
 *
 * A model that genuinely needs to emit more than this takes an explicit
 * `maxTokens` from the caller, which is quoted and paid for deliberately.
 */
export const DEFAULT_MAX_TOKENS_CEILING = 8_192

/** Input modalities for an entry the gateway does not tag `vision`. */
const TEXT_ONLY: readonly ModelModality[] = ['text']

/**
 * Input modalities for a `vision`-tagged entry.
 *
 * Declared from the catalog's own tag rather than for every model: claiming
 * image input on a text-only model would admit an attachment the request then
 * refuses, after the message is already durable, leaving the session repeating
 * a request that cannot succeed.
 */
const TEXT_AND_IMAGE: readonly ModelModality[] = ['text', 'image']

/** The capability tag marking an entry that can reason before answering. */
const REASONING_CATEGORY = 'reasoning'

/**
 * Reasoning efforts offered for a `reasoning`-tagged model.
 *
 * Declared from the tag, unlike vision, because the two get it wrong at very
 * different cost. A wrongly-claimed vision model charges and then fails; a
 * wrongly-claimed effort is translated to the vendor's nearest value and the
 * answer still arrives. Sending an effort to a model that does not reason at
 * all IS a paid failure on OpenAI, and {@link BlockrunAdapter} refuses that
 * locally instead of paying to discover it.
 */
const REASONING_EFFORTS = [
  { id: 'high' as ReasoningEffortId, name: 'High' },
  { id: 'max' as ReasoningEffortId, name: 'Max', description: 'Most thinking the vendor offers' },
]

/** The capability tag marking an entry that accepts image input. */
const VISION_CATEGORY = 'vision'

/**
 * Models measured to actually accept an image through this gateway.
 *
 * The `vision` tag is not sufficient. Every tagged chat model is sent a solid
 * PNG and asked its colour; only the ones that answer correctly are listed.
 * Measured with `npm run probe:vision` on 2026-08-31: 34 of 40 answered, in
 * three different colours each — one colour is guessable, and the earlier
 * hand runs used one.
 *
 * The six left out fall into three kinds, and only the first is the model's
 * own fault:
 *
 * - **Refuses or ignores the image.** `openai/gpt-5.2-pro`, `gpt-5.4-pro` and
 *   `gpt-5.5-pro` now fail `INVALID_REQUEST` on all three colours; until
 *   2026-08-30 they dropped the image and answered as if none was sent, which
 *   was billed, so failing loudly is an upstream improvement.
 *   `nvidia/llama-3.2-11b-vision` answers "you didn't provide an image".
 * - **Never actually measured, because a different model answered.**
 *   `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` and `qwen/qwen3.8-flash`
 *   were served by `nvidia/nemotron-3-nano-30b` and `qwen/qwen3.7-flash`
 *   respectively — neither of which is the model that was asked for, so
 *   neither run says anything about the model under test. nano-omni does pass
 *   when the gateway happens to reach it, which is the trap: an entry that
 *   works when the cascade feels like it produces a confident wrong answer
 *   about an image the model never received (BlockRunAI/blockrun#450).
 *
 * `openai/gpt-5.6-luna-pro` was excluded for returning HTTP 500 after taking
 * payment and now passes; the gateway fixed it.
 *
 * Declaring image input from the tag would therefore admit an attachment that
 * fails mid-turn, after the message is durable, having already been paid for.
 * The default is the measured set; `visionModels` widens it as the gateway
 * improves, without waiting for a release here.
 */
export const VERIFIED_VISION_MODELS: readonly string[] = [
  'anthropic/claude-fable-5',
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-opus-4.5',
  'anthropic/claude-opus-4.7',
  'anthropic/claude-opus-4.8',
  'anthropic/claude-opus-5',
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-sonnet-5',
  'deepseek/deepseek-v4-flash-vision-exp',
  'google/gemini-2.5-flash',
  'google/gemini-2.5-pro',
  'google/gemini-3-flash-preview',
  'google/gemini-3.1-pro',
  'google/gemini-3.5-flash',
  'google/gemini-3.6-flash',
  'moonshot/kimi-k3',
  'openai/chat-latest',
  'openai/gpt-4.1',
  'openai/gpt-4o',
  'openai/gpt-5.2',
  'openai/gpt-5.4',
  'openai/gpt-5.4-mini',
  'openai/gpt-5.5',
  'openai/gpt-5.6-luna',
  'openai/gpt-5.6-luna-pro',
  'openai/gpt-5.6-sol',
  'openai/gpt-5.6-sol-pro',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-terra-pro',
  'xai/grok-4.3',
  'xai/grok-4.5',
  'xiaomi/mimo-v2.5',
  'zai/glm-5.3-flash',
]

/** The capability tag marking an entry this route can actually converse with. */
const CHAT_CATEGORY = 'chat'

/**
 * The `billing_mode` marking an entry the gateway serves without payment.
 *
 * Read from this field alone, never inferred from a `0` price. An entry whose
 * pricing the catalog simply omits, or states as zero by mistake, must fall
 * through to the paid path — that path only asks for a wallet key the
 * deployment already configured, whereas guessing "free" wrongly sends a
 * request with no means to pay and reports its cost as nothing.
 */
const FREE_BILLING_MODE = 'free'

interface CacheEntry {
  models: readonly LlmResolvedModelInfo[]
  /** Published per-million rates by model id; absent for a model the catalog does not price. */
  rates: ReadonlyMap<string, ModelRates>
  /** Ids the catalog bills as `free`; these settle nothing and need no wallet. */
  freeModels: ReadonlySet<string>
  fetchedAt: number
}

/** Reads the catalog at most once per {@link CATALOG_TTL_MS}, sharing one in-flight request. */
export class BlockrunCatalog {
  #cache: CacheEntry | undefined
  #inFlight: Promise<readonly LlmResolvedModelInfo[]> | undefined

  /**
   * @param provider - harness route key stamped onto every entry.
   * @param baseURL - gateway base, e.g. `https://blockrun.ai/api/v1`.
   * @param now - clock, injected so cache expiry is testable.
   */
  constructor(
    private readonly provider: string,
    private readonly baseURL: string,
    private readonly now: () => number = Date.now,
    private readonly visionModels: readonly string[] = VERIFIED_VISION_MODELS,
    private readonly maxOutputCeiling: number = DEFAULT_MAX_TOKENS_CEILING,
  ) {}

  /** Published rates from the last successful read, by model id. */
  get rates(): ReadonlyMap<string, ModelRates> {
    return this.#cache?.rates ?? new Map()
  }

  /** Ids the last successful read billed as `free`. */
  get freeModels(): ReadonlySet<string> {
    return this.#cache?.freeModels ?? new Set()
  }

  /**
   * Whether the gateway serves this model without payment.
   *
   * Answers `false` when the catalog cannot be read, rather than propagating
   * the failure: every caller uses this to decide whether a wallet is needed
   * and what a call cost, and both questions have a safe answer already —
   * require the configured key, and price the call. A catalog blip must not
   * turn into a refused request or an under-reported bill.
   *
   * @param model - BlockRun model id.
   * @param signal - cancels the underlying catalog read.
   * @returns true only when the catalog states `billing_mode: "free"`.
   */
  async isFree(model: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.list(signal)
    } catch {
      return false
    }
    return this.freeModels.has(model)
  }

  /**
   * All catalog models for this route.
   * @param signal - cancels the underlying fetch.
   * @returns every model the gateway currently lists.
   * @throws LlmError when no catalog has ever been read and the fetch fails.
   */
  async list(signal?: AbortSignal): Promise<readonly LlmResolvedModelInfo[]> {
    const cached = this.#cache
    if (cached !== undefined && this.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached.models
    // The shared fetch deliberately carries NO caller signal. One request is
    // reused by every concurrent caller, so binding it to whichever caller
    // happened to arrive first would let that caller's cancellation fail
    // everyone else's read. Its own deadline bounds it instead; a caller that
    // cancels stops waiting below without disturbing the request.
    this.#inFlight ??= this.#refresh().finally(() => {
      this.#inFlight = undefined
    })
    const inFlight = this.#inFlight
    try {
      return await (signal === undefined ? inFlight : this.#raceAbort(inFlight, signal))
    } catch (error) {
      // A caller that cancelled gets its cancellation, never a stale answer
      // dressed up as a fresh one.
      if (signal?.aborted === true) throw error
      // Serve the previous catalog through a transient gateway failure: a
      // selector that listed 70 models a minute ago must not empty because one
      // refresh timed out. With nothing cached there is no honest answer, so
      // the failure surfaces.
      if (cached !== undefined) return cached.models
      throw error
    }
  }

  /** Stop waiting on `pending` when `signal` aborts, leaving `pending` itself untouched. */
  async #raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new LlmError('BlockRun catalog read aborted by caller', 'ABORTED', { cause: signal.reason })
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          onAbort = (): void => {
            reject(new LlmError('BlockRun catalog read aborted by caller', 'ABORTED', { cause: signal.reason }))
          }
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * One exact model's descriptor.
   * @param model - BlockRun model id.
   * @param signal - cancels the underlying fetch.
   * @returns the descriptor for `model`.
   * @throws LlmError `UNKNOWN_MODEL` when the catalog does not list it.
   */
  async resolve(model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const models = await this.list(signal)
    const found = models.find(entry => entry.id === model)
    if (found === undefined) {
      // With seventy slash-prefixed ids, a wrong name is almost always a near
      // miss — a dropped `vendor/` prefix, a missing hyphen, a stale suffix —
      // so the useful answer is the name they meant, not the fact they were
      // wrong.
      const suggestions = suggestModels(model, models.map(entry => entry.id))
      throw new LlmError(
        `BlockRun does not serve model "${model}" on provider route "${this.provider}".`
        + (suggestions.length > 0 ? ` Did you mean ${suggestions.map(id => `"${id}"`).join(', ')}?` : '')
        + ` The full list is at ${this.baseURL.replace(/\/$/, '')}/models.`,
        'UNKNOWN_MODEL',
      )
    }
    return found
  }

  async #refresh(): Promise<readonly LlmResolvedModelInfo[]> {
    const url = `${this.baseURL.replace(/\/$/, '')}/models`
    // This request answers every concurrent caller, so it owns its own
    // deadline: without one, a hung gateway would park the shared promise
    // indefinitely and every later caller would join the same stall.
    const deadline = AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(url, { headers: { accept: 'application/json' }, signal: deadline })
    } catch (error) {
      throw new LlmError(`BlockRun model catalog request failed (${url})`, 'TRANSPORT', { cause: error })
    }
    if (!response.ok) {
      throw new LlmError(
        `BlockRun model catalog returned HTTP ${response.status} (${url})`,
        'TRANSPORT',
        { status: response.status },
      )
    }
    const body: unknown = await response.json()
    const models = projectCatalog(this.provider, body, this.visionModels, this.maxOutputCeiling)
    this.#cache = { models, rates: projectRates(body), freeModels: projectFreeModels(body), fetchedAt: this.now() }
    return models
  }
}

/**
 * Project a raw catalog response onto harness descriptors.
 *
 * Validation is real here, not defensive duplication: this is a wire boundary,
 * and an entry without a usable `id` cannot be requested, so it is dropped
 * rather than surfaced as an unselectable row.
 * @param provider - harness route key stamped onto every entry.
 * @param body - decoded `GET /models` response.
 * @returns descriptors for every entry carrying a non-empty string id.
 */
export function projectCatalog(
  provider: string,
  body: unknown,
  visionModels: readonly string[] = VERIFIED_VISION_MODELS,
  maxOutputCeiling: number = DEFAULT_MAX_TOKENS_CEILING,
): readonly LlmResolvedModelInfo[] {
  const data = (body as { data?: unknown })?.data
  const entries: unknown[] = Array.isArray(data) ? data : Array.isArray(body) ? body : []
  const models: LlmResolvedModelInfo[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const model = entry as BlockrunCatalogModel
    if (typeof model.id !== 'string' || model.id.length === 0) continue
    if (!isChatCapable(model)) continue
    models.push(projectModel(provider, model, visionModels, maxOutputCeiling))
  }
  return models
}

/**
 * Whether this entry belongs in a chat model selector.
 *
 * The catalog also lists image, video, music, and speech models, which this
 * route cannot converse with — offering one as an agent model would let a user
 * select it and get a failure on the first turn. An entry declaring no
 * categories at all is kept: another OpenAI-compatible gateway behind a
 * configured `apiUrl` may not tag its models, and hiding everything it serves
 * would be worse than showing one that turns out to be unusable.
 */
function isChatCapable(model: BlockrunCatalogModel): boolean {
  if (model.categories === undefined) return true
  return model.categories.includes(CHAT_CATEGORY)
}

/**
 * Whether an image may be sent to this entry.
 *
 * Both the gateway's tag and the verified list must agree: the tag alone
 * over-claims (see {@link VERIFIED_VISION_MODELS}), and the list alone would
 * keep claiming vision for an entry the gateway has since retagged.
 */
function acceptsImages(model: BlockrunCatalogModel, visionModels: readonly string[]): boolean {
  return model.categories?.includes(VISION_CATEGORY) === true && visionModels.includes(model.id)
}

/** Project one catalog entry; every harness-owned default is applied here rather than at use. */
function projectModel(
  provider: string,
  model: BlockrunCatalogModel,
  visionModels: readonly string[],
  maxOutputCeiling: number,
): LlmResolvedModelInfo {
  const description = model.description
  return {
    provider,
    id: model.id,
    name: model.name !== undefined && model.name.length > 0 ? model.name : model.id,
    ...description === undefined || description.length === 0 ? {} : { description },
    inputModalities: [...acceptsImages(model, visionModels) ? TEXT_AND_IMAGE : TEXT_ONLY],
    ...model.categories?.includes(REASONING_CATEGORY) === true
      ? { reasoning: { efforts: REASONING_EFFORTS } }
      : {},
    context: {
      contextWindow: positive(model.context_window) ?? positive(model.context_length) ?? DEFAULT_CONTEXT_WINDOW,
    },
    defaultMaxTokens: Math.min(positive(model.max_output) ?? DEFAULT_MAX_TOKENS, maxOutputCeiling),
  }
}

/** Comparison form: case and punctuation carry no meaning across model ids. */
function normalize(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The catalog ids a mistyped one most likely meant.
 *
 * Containment first, because the two most common mistakes are structural
 * rather than typographic: dropping the `vendor/` prefix (`deepseek-chat`) and
 * truncating a suffix (`deepseek/deepseek-v4`). Edit distance then catches the
 * genuine typos — a missing hyphen in `claude-opus5`, a transposition — and is
 * bounded so that a wholly unrelated string suggests nothing at all rather
 * than the alphabetically nearest noise.
 * @param model - the id that was not found.
 * @param known - every id the catalog serves.
 * @param limit - most suggestions to return.
 * @returns the closest ids, best first.
 */
export function suggestModels(model: string, known: readonly string[], limit = 3): string[] {
  const wanted = normalize(model)
  if (wanted.length === 0) return []
  const scored: { id: string; score: number }[] = []
  for (const id of known) {
    const candidate = normalize(id)
    if (candidate === wanted) return [id]
    if (candidate.endsWith(wanted) || candidate.startsWith(wanted)) {
      scored.push({ id, score: 1 })
      continue
    }
    if (candidate.includes(wanted) || wanted.includes(candidate)) {
      scored.push({ id, score: 2 })
      continue
    }
    const distance = editDistance(wanted, candidate)
    // A third of the length is loose enough for a dropped hyphen and tight
    // enough that an unrelated name proposes nothing.
    if (distance <= Math.max(1, Math.floor(Math.max(wanted.length, candidate.length) / 3))) {
      scored.push({ id, score: 3 + distance })
    }
  }
  return scored.sort((left, right) => left.score - right.score || left.id.localeCompare(right.id))
    .slice(0, limit)
    .map(entry => entry.id)
}

/** Levenshtein distance, iterative single-row. */
function editDistance(left: string, right: string): number {
  if (left === right) return 0
  let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index)
  for (let i = 1; i <= left.length; i++) {
    const current = [i]
    for (let j = 1; j <= right.length; j++) {
      const substitution = previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1)
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, substitution)
    }
    previous = current
  }
  return previous[right.length]!
}

/** Published per-million rates by model id, for every entry that states one. */
export function projectRates(body: unknown): ReadonlyMap<string, ModelRates> {
  const data = (body as { data?: unknown })?.data
  const entries: unknown[] = Array.isArray(data) ? data : Array.isArray(body) ? body : []
  const rates = new Map<string, ModelRates>()
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const model = entry as BlockrunCatalogModel
    if (typeof model.id !== 'string' || model.id.length === 0) continue
    const input = rate(model.pricing?.input)
    const output = rate(model.pricing?.output)
    if (input === undefined && output === undefined) continue
    rates.set(model.id, {
      ...input === undefined ? {} : { input },
      ...output === undefined ? {} : { output },
    })
  }
  return rates
}

/**
 * The ids the catalog bills as free, for every entry that says so.
 *
 * Free entries are not a curiosity of the price list: the gateway answers them
 * with HTTP 200 and no x402 handshake at all, so they need no wallet and
 * settle nothing. Measured 2026-08-30 against the live gateway —
 * `nvidia/nemotron-3.5-lightning`, `cohere/north-mini-code` and
 * `poolside/laguna-xs-2.1` all returned 200 unpaid, where
 * `deepseek/deepseek-chat` returned 402.
 *
 * Read across the whole response rather than only the chat entries, so a
 * caller asking about any id gets the catalog's own answer.
 * @param body - decoded `GET /models` response.
 * @returns every id declaring `billing_mode: "free"`.
 */
export function projectFreeModels(body: unknown): ReadonlySet<string> {
  const data = (body as { data?: unknown })?.data
  const entries: unknown[] = Array.isArray(data) ? data : Array.isArray(body) ? body : []
  const free = new Set<string>()
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const model = entry as BlockrunCatalogModel
    if (typeof model.id !== 'string' || model.id.length === 0) continue
    if (model.billing_mode === FREE_BILLING_MODE) free.add(model.id)
  }
  return free
}

/** A usable non-negative rate; a free model's explicit 0 is kept, nonsense is dropped. */
function rate(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

/** A finite positive integer, or undefined for anything a capacity cannot be read from. */
function positive(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

/** Narrow a resolved descriptor to the listing projection. */
export function toModelInfo(model: LlmResolvedModelInfo): LlmModelInfo {
  const { provider, id, name, description, inputModalities } = model
  return {
    provider,
    id,
    name,
    ...description === undefined ? {} : { description },
    ...inputModalities === undefined ? {} : { inputModalities },
  }
}

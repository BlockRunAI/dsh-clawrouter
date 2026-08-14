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

import type { LlmModelInfo, LlmResolvedModelInfo, ModelModality } from '@deepseek-ai/dsh-llm'
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
 * Every model on this route is declared text-only, including the ones whose
 * catalog entry is tagged `vision`.
 *
 * This adapter does not yet serialize image content, so claiming the capability
 * would admit an attachment the request then refuses — after the message is
 * durable, leaving the session repeating a request that cannot succeed.
 * Under-claiming instead refuses the image up front, naming the model. The two
 * wrong answers do not cost the same. Widen this the moment `serialize.ts`
 * carries images.
 */
const DECLARED_INPUT: readonly ModelModality[] = ['text']

/** The capability tag marking an entry this route can actually converse with. */
const CHAT_CATEGORY = 'chat'

interface CacheEntry {
  models: readonly LlmResolvedModelInfo[]
  /** Published per-million rates by model id; absent for a model the catalog does not price. */
  rates: ReadonlyMap<string, ModelRates>
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
  ) {}

  /** Published rates from the last successful read, by model id. */
  get rates(): ReadonlyMap<string, ModelRates> {
    return this.#cache?.rates ?? new Map()
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
    const models = projectCatalog(this.provider, body)
    this.#cache = { models, rates: projectRates(body), fetchedAt: this.now() }
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
export function projectCatalog(provider: string, body: unknown): readonly LlmResolvedModelInfo[] {
  const data = (body as { data?: unknown })?.data
  const entries: unknown[] = Array.isArray(data) ? data : Array.isArray(body) ? body : []
  const models: LlmResolvedModelInfo[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const model = entry as BlockrunCatalogModel
    if (typeof model.id !== 'string' || model.id.length === 0) continue
    if (!isChatCapable(model)) continue
    models.push(projectModel(provider, model))
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

/** Project one catalog entry; every harness-owned default is applied here rather than at use. */
function projectModel(provider: string, model: BlockrunCatalogModel): LlmResolvedModelInfo {
  const description = model.description
  return {
    provider,
    id: model.id,
    name: model.name !== undefined && model.name.length > 0 ? model.name : model.id,
    ...description === undefined || description.length === 0 ? {} : { description },
    inputModalities: [...DECLARED_INPUT],
    context: {
      contextWindow: positive(model.context_window) ?? positive(model.context_length) ?? DEFAULT_CONTEXT_WINDOW,
    },
    defaultMaxTokens: positive(model.max_output) ?? DEFAULT_MAX_TOKENS,
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

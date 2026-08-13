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

/** How long a successful catalog read is reused before the next fetch. */
export const CATALOG_TTL_MS = 300_000

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

  /**
   * All catalog models for this route.
   * @param signal - cancels the underlying fetch.
   * @returns every model the gateway currently lists.
   * @throws LlmError when no catalog has ever been read and the fetch fails.
   */
  async list(signal?: AbortSignal): Promise<readonly LlmResolvedModelInfo[]> {
    const cached = this.#cache
    if (cached !== undefined && this.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached.models
    this.#inFlight ??= this.#refresh(signal).finally(() => {
      this.#inFlight = undefined
    })
    try {
      return await this.#inFlight
    } catch (error) {
      // Serve the previous catalog through a transient gateway failure: a
      // selector that listed 70 models a minute ago must not empty because one
      // refresh timed out. With nothing cached there is no honest answer, so
      // the failure surfaces.
      if (cached !== undefined) return cached.models
      throw error
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
      throw new LlmError(
        `BlockRun does not serve model "${model}" on provider route "${this.provider}"`,
        'UNKNOWN_MODEL',
      )
    }
    return found
  }

  async #refresh(signal?: AbortSignal): Promise<readonly LlmResolvedModelInfo[]> {
    const url = `${this.baseURL.replace(/\/$/, '')}/models`
    let response: Response
    try {
      response = await fetch(url, {
        headers: { accept: 'application/json' },
        ...signal === undefined ? {} : { signal },
      })
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
    this.#cache = { models, fetchedAt: this.now() }
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

/**
 * Shared type declarations. Types only — no runtime code, so importing this
 * module can never pull transport or SDK code into a consumer.
 *
 * @module dsh-clawrouter/types
 */

/** One entry of BlockRun's `GET /api/v1/models` response. */
export interface BlockrunCatalogModel {
  /** Model id passed straight through as `GenerateOptions.model`. */
  id: string
  /** Human-readable name for selectors; falls back to `id`. */
  name?: string
  /** One-line capability summary shown beside the name. */
  description?: string
  /** Combined request + response capacity in tokens. */
  context_window?: number
  /** The same capacity under the spelling some other OpenAI-compatible gateways use. */
  context_length?: number
  /** Provider-side maximum output tokens. */
  max_output?: number
  /**
   * Capability tags. `chat` marks a model this route can actually converse
   * with; media-only models (image, video, music, speech) carry other tags and
   * would fail a chat request.
   */
  categories?: string[]
  /**
   * How the model is billed. `paid` and `free` are per-token chat; the
   * `per_image` / `per_track` / `per_character` / `per_generation` /
   * `per_second` modes belong to media endpoints this route does not serve.
   */
  billing_mode?: string
  /** USD per million tokens. */
  pricing?: { input?: number; output?: number }
}

/** One streamed tool-call fragment; `index` correlates fragments of the same call. */
export interface BlockrunToolCallDelta {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

/** OpenAI-compatible streaming delta, the wire form BlockRun emits. */
export interface BlockrunStreamChunk {
  choices?: {
    index?: number
    delta?: {
      content?: string | null
      /** DeepSeek-dialect thinking text, distinct from `content`. */
      reasoning_content?: string | null
      tool_calls?: BlockrunToolCallDelta[]
    }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    /** Cached prompt tokens, folded INTO `prompt_tokens` by the provider. */
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  } | null
}

/** A reviewer's verdict on one proposed tool call. */
export interface ReviewVerdict {
  /**
   * `safe` lets the call proceed to the remaining policy chain, `dangerous`
   * denies it outright, and `uncertain` escalates to the human approver.
   */
  ruling: 'safe' | 'dangerous' | 'uncertain'
  /** Model-facing explanation; for a denial this is what the agent reads. */
  reason: string
}

/** Why a tool call was selected for review, recorded for the audit log. */
export interface RiskMatch {
  /** The rule that matched, named so a user can tune or remove it. */
  rule: string
  /** The exact text that triggered the rule, for the reviewer's context. */
  evidence: string
}

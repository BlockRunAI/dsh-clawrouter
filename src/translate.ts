/**
 * Translate BlockRun's OpenAI-compatible stream deltas into the harness
 * `StreamChunk` protocol.
 *
 * The translator is stateful across one response and enforces the protocol's
 * three ordering obligations: block indexes are allocated in first-seen order
 * and reused for every delta of the same block, tool-call arguments stay raw
 * JSON strings, and `usage` is emitted before a terminal `finish` with nothing
 * after it. Finish and usage are therefore buffered until the caller signals
 * end-of-stream, which also absorbs providers that send a trailing usage-only
 * chunk after the finish-bearing one.
 *
 * @module dsh-clawrouter/translate
 */

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { BlockrunStreamChunk, BlockrunToolCallDelta } from './types.ts'

/** One harness block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  /** Accumulated text, or accumulated raw JSON for a tool call. */
  text: string
  /** Present only for `tool-call`. */
  callId?: string
  name?: string
}

/** Accumulates one response and emits harness chunks in protocol order. */
export class StreamTranslator {
  #blocks = new Map<string, OpenBlock>()
  #nextIndex = 0
  #finish: FinishReason | undefined
  #usage: TokenUsage | undefined
  #closed = false

  /**
   * Translate one wire chunk.
   * @param chunk - a decoded `data:` payload.
   * @returns harness chunks for this payload, in emission order.
   */
  accept(chunk: BlockrunStreamChunk): StreamChunk[] {
    if (this.#closed) return []
    const out: StreamChunk[] = []
    if (chunk.usage != null) this.#usage = projectUsage(chunk.usage)
    const choice = chunk.choices?.[0]
    if (choice === undefined) return out

    const delta = choice.delta
    if (delta != null) {
      // Reasoning first: a provider that interleaves both in one delta emits
      // thinking that precedes the visible text it produced.
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        out.push(...this.#appendText('reasoning', 'reasoning', delta.reasoning_content))
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        out.push(...this.#appendText('text', 'text', delta.content))
      }
      for (const call of delta.tool_calls ?? []) out.push(...this.#appendToolCall(call))
    }

    // Buffered, not emitted: nothing may follow `finish`, and a trailing
    // usage-only chunk can still arrive after this one.
    if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
      this.#finish = projectFinishReason(choice.finish_reason)
    }
    return out
  }

  /**
   * Close the response and flush the terminal chunks.
   * @returns every open `block-end`, then `usage`, then exactly one `finish`.
   * @throws LlmError `EMPTY_RESPONSE` when the stream ended with no content and no finish reason.
   */
  end(): StreamChunk[] {
    if (this.#closed) return []
    this.#closed = true
    const out: StreamChunk[] = []
    for (const block of this.#blocks.values()) {
      out.push({ type: 'block-end', index: block.index, block: assemble(block) })
    }
    if (this.#usage !== undefined) out.push({ type: 'usage', usage: this.#usage })
    if (this.#finish === undefined) {
      if (this.#blocks.size === 0) {
        throw new LlmError('BlockRun returned an empty stream with no finish reason', EMPTY_RESPONSE_CODE)
      }
      // Content arrived but the provider never named a reason. Reporting the
      // observed outcome beats inventing an error the response does not show.
      this.#finish = [...this.#blocks.values()].some(block => block.kind === 'tool-call')
        ? { kind: 'tool-calls' }
        : { kind: 'stop' }
    }
    out.push({ type: 'finish', reason: this.#finish })
    return out
  }

  /** Open or extend the single text or reasoning block, emitting `block-start` on first sight. */
  #appendText(key: 'text' | 'reasoning', kind: 'text' | 'reasoning', text: string): StreamChunk[] {
    const out: StreamChunk[] = []
    let block = this.#blocks.get(key)
    if (block === undefined) {
      block = { index: this.#nextIndex++, kind, text: '' }
      this.#blocks.set(key, block)
      out.push({ type: 'block-start', index: block.index, blockType: kind })
    }
    block.text += text
    out.push(kind === 'text'
      ? { type: 'text-delta', index: block.index, text }
      : { type: 'reasoning-delta', index: block.index, text })
    return out
  }

  /** Open or extend one tool-call block, keyed by the provider's own call index. */
  #appendToolCall(call: BlockrunToolCallDelta): StreamChunk[] {
    const out: StreamChunk[] = []
    const key = `tool:${call.index}`
    let block = this.#blocks.get(key)
    if (block === undefined) {
      const name = call.function?.name
      block = {
        index: this.#nextIndex++,
        kind: 'tool-call',
        text: '',
        callId: call.id ?? '',
        ...name === undefined ? {} : { name },
      }
      this.#blocks.set(key, block)
      out.push({ type: 'block-start', index: block.index, blockType: 'tool-call' })
    }
    // The id and name usually arrive only on the opening fragment; a later
    // fragment that carries them again must not blank what is already known.
    if (call.id !== undefined && call.id.length > 0) block.callId = call.id
    if (call.function?.name !== undefined && call.function.name.length > 0) block.name = call.function.name

    const argumentsDelta = call.function?.arguments ?? ''
    block.text += argumentsDelta
    out.push({
      type: 'tool-call-delta',
      index: block.index,
      id: CallId(block.callId ?? ''),
      ...block.name === undefined ? {} : { name: block.name },
      argumentsDelta,
    })
    return out
  }
}

/** Assemble the durable block from its accumulated fragments. */
function assemble(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: CallId(block.callId ?? ''),
        name: block.name ?? '',
        // Raw JSON end to end. An empty argument stream means "no arguments",
        // which every provider spells `{}` — the model never sent the string.
        arguments: block.text.length === 0 ? '{}' : block.text,
      }
  }
}

/** Map an OpenAI finish reason onto the harness vocabulary. */
function projectFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    default:
      // `stop`, `content_filter`, and any provider-specific spelling: the
      // response ended and produced what it produced.
      return { kind: 'stop' }
  }
}

/**
 * Project provider usage onto the harness's DISJOINT buckets.
 *
 * OpenAI-compatible gateways fold cached prompt tokens INTO `prompt_tokens`,
 * while the harness requires uncached input and cache reads to be disjoint —
 * so the cached count is subtracted out rather than reported twice. Reasoning
 * tokens are a subdivision of output and are never added again.
 */
function projectUsage(usage: NonNullable<BlockrunStreamChunk['usage']>): TokenUsage {
  const prompt = count(usage.prompt_tokens)
  const cached = Math.min(count(usage.prompt_tokens_details?.cached_tokens), prompt)
  const reasoning = count(usage.completion_tokens_details?.reasoning_tokens)
  return {
    inputTokens: prompt - cached,
    outputTokens: count(usage.completion_tokens),
    ...cached === 0 ? {} : { cacheReadTokens: cached },
    ...reasoning === 0 ? {} : { reasoningTokens: reasoning },
  }
}

/** A non-negative integer token count; anything unusable reads as zero. */
function count(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

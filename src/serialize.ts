/**
 * Request serialization: harness `GenerateOptions` onto BlockRun's
 * OpenAI-compatible `/chat/completions` body.
 *
 * @module dsh-clawrouter/serialize
 */

import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/**
 * Read one image attachment and return it as a `data:` URL.
 *
 * Images arrive as content-addressed references, never bytes, so sending one
 * requires a read through the attachment service. Passing this in keeps
 * serialization a pure function of its inputs and testable without a store.
 *
 * @param ref - the reference carried by the image block.
 * @returns a `data:<mediaType>;base64,<payload>` URL.
 */
export type ImageResolver = (ref: ImageAttachmentRef) => Promise<string>

/** One part of a multimodal message body. */
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** One OpenAI-compatible request message. */
interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | ContentPart[]
  tool_call_id?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
}

/**
 * Build the streaming request body.
 * @param options - the harness request.
 * @param resolveImage - reads image attachments; omit for a text-only build, which then refuses an image.
 * @returns a JSON body for `POST /chat/completions`.
 * @throws LlmError `UNSUPPORTED` for a request this adapter cannot express.
 */
export async function buildRequestBody(
  options: GenerateOptions,
  resolveImage?: ImageResolver,
): Promise<Record<string, unknown>> {
  const messages: WireMessage[] = []
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages) messages.push(...await serializeMessage(message, resolveImage))
  return {
    model: options.model,
    messages,
    stream: true,
    // Ask for the usage record on the terminal chunk; without it the harness
    // has no provider-reported token accounting and every figure downstream
    // falls back to a heuristic.
    stream_options: { include_usage: true },
    ...options.tools === undefined || options.tools.length === 0 ? {} : { tools: serializeTools(options.tools) },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop === undefined || options.stop.length === 0 ? {} : { stop: [...options.stop] },
    ...options.reasoningEffort === undefined
      ? {}
      : { reasoning_effort: reasoningEffortFor(options.model, options.reasoningEffort) },
  }
}

/** Serialize one harness message; a tool-result block becomes its own `tool` message. */
async function serializeMessage(message: Message, resolveImage?: ImageResolver): Promise<WireMessage[]> {
  const toolResults = message.content.filter(block => block.type === 'tool-result')
  if (toolResults.length > 0 && message.role !== 'assistant') {
    const text = flattenText(message.content)
    return [
      // Tool results ride in user-role messages in the harness vocabulary, and
      // one normally travels alone. When a message carries text as well, that
      // text is something the user said — dropping it would silently delete a
      // turn's input on the way to the model.
      ...text.length > 0 ? [{ role: 'user' as const, content: text }] : [],
      ...toolResults.map(block => ({
        role: 'tool' as const,
        tool_call_id: block.toolCallId,
        // A tool that succeeded while printing nothing is ordinary — `chmod`,
        // `mkdir`, a quiet build. The wire still needs some content: an empty
        // string reads as a malformed tool message to strict gateways.
        content: flattenText(block.content) || '(no output)',
      })),
    ]
  }
  if (message.role === 'assistant') {
    const calls = message.content.filter(block => block.type === 'tool-call')
    const text = flattenText(message.content)
    return [{
      role: 'assistant',
      // An assistant turn that only called tools carries no text; the field
      // stays present and empty because some gateways reject a missing one.
      content: text,
      ...calls.length === 0 ? {} : {
        tool_calls: calls.map(call => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      },
    }]
  }
  return [{
    role: message.role === 'system' ? 'system' : 'user',
    content: await renderContent(message.content, resolveImage),
  }]
}

/**
 * Render user-role content, carrying images when the message has any.
 *
 * A message with no image serializes to a bare string exactly as before.
 * Switching every message to the parts array would be a wire change affecting
 * all traffic to gain nothing, and gateways vary in how well they accept it.
 */
async function renderContent(
  content: readonly ContentBlock[],
  resolveImage?: ImageResolver,
): Promise<string | ContentPart[]> {
  const images = content.filter(block => block.type === 'image')
  if (images.length === 0) return flattenText(content)
  if (resolveImage === undefined) {
    throw new LlmError(
      'dsh-clawrouter cannot send an image without the attachment service; compose @deepseek-ai/dsh-attachment or remove the attachment',
      'UNSUPPORTED',
    )
  }
  // Flattened without the image blocks: `flattenText` throws on one, since
  // every other slot it serves takes a string on the wire.
  const text = flattenText(content.filter(block => block.type !== 'image'))
  return [
    ...text.length === 0 ? [] : [{ type: 'text' as const, text }],
    // Resolved in parallel: a turn can carry several screenshots, and reading
    // them one after another adds their latencies for no reason.
    ...await Promise.all(images.map(async block => ({
      type: 'image_url' as const,
      image_url: { url: await resolveImage(block.attachment) },
    }))),
  ]
}

/**
 * Concatenate the text-bearing blocks of one content list.
 *
 * Reasoning blocks are deliberately dropped: they are the model's own thinking
 * from an earlier turn, and no OpenAI-compatible request slot carries them
 * back. An image block instead fails loud — silently dropping it would send a
 * request that reads as if the user never attached anything.
 *
 * User-role content goes through {@link renderContent}, which carries images.
 * This path remains for the two slots that are string-only on the wire: an
 * assistant turn and a `tool` message.
 */
function flattenText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'reasoning':
      case 'tool-call':
      case 'tool-result':
        break
      case 'image':
        // Reachable only from an assistant turn or a tool result, whose
        // OpenAI content field is a string. A screenshot-returning tool has to
        // hand back a reference in text rather than an image block.
        throw new LlmError(
          'dsh-clawrouter cannot put an image in an assistant or tool message; only user messages carry images',
          'UNSUPPORTED',
        )
      default:
        // Merge-extensible union: an unknown block type is a newer harness
        // vocabulary this build cannot render, not a malformed value.
        break
    }
  }
  return parts.join('')
}

/**
 * Translate a harness reasoning effort into the value this model's vendor accepts.
 *
 * `max` is DeepSeek's vocabulary, which the harness adopts. OpenAI's is
 * `low | medium | high`, and it returns HTTP 400 **after taking payment** for
 * anything else — measured against the live gateway on `openai/gpt-5.6-sol`.
 * Anthropic, Google and xAI accepted `max` without error and without producing
 * reasoning content either way, so downgrading them loses nothing.
 *
 * Downgrading rather than refusing is the right trade here: the caller asked
 * for the most thinking available, and every vendor has a most. Refusing would
 * turn a routine request into a hard failure over a spelling.
 *
 * @param model - the gateway model id, whose vendor prefix selects the dialect.
 * @param effort - the harness effort id.
 * @returns the value to send as `reasoning_effort`.
 */
export function reasoningEffortFor(model: string, effort: string): string {
  if (effort === 'max' && !model.startsWith('deepseek/')) return 'high'
  return effort
}

/** Serialize tool schemas into OpenAI's `tools` array. */
function serializeTools(tools: readonly ToolSchema[]): Record<string, unknown>[] {
  return tools.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

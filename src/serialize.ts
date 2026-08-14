/**
 * Request serialization: harness `GenerateOptions` onto BlockRun's
 * OpenAI-compatible `/chat/completions` body.
 *
 * @module dsh-clawrouter/serialize
 */

import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** One OpenAI-compatible request message. */
interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  tool_call_id?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
}

/**
 * Build the streaming request body.
 * @param options - the harness request.
 * @returns a JSON body for `POST /chat/completions`.
 * @throws LlmError `UNSUPPORTED` for a request this adapter cannot express.
 */
export function buildRequestBody(options: GenerateOptions): Record<string, unknown> {
  const messages: WireMessage[] = []
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages) messages.push(...serializeMessage(message))
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
  }
}

/** Serialize one harness message; a tool-result block becomes its own `tool` message. */
function serializeMessage(message: Message): WireMessage[] {
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
  return [{ role: message.role === 'system' ? 'system' : 'user', content: flattenText(message.content) }]
}

/**
 * Concatenate the text-bearing blocks of one content list.
 *
 * Reasoning blocks are deliberately dropped: they are the model's own thinking
 * from an earlier turn, and no OpenAI-compatible request slot carries them
 * back. An image block instead fails loud — silently dropping it would send a
 * request that reads as if the user never attached anything.
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
        throw new LlmError(
          'dsh-clawrouter does not yet send image content to BlockRun; select a text-only model or remove the attachment',
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

/** Serialize tool schemas into OpenAI's `tools` array. */
function serializeTools(tools: readonly ToolSchema[]): Record<string, unknown>[] {
  return tools.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

import { describe, expect, it } from 'vitest'
import { CallId, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { buildRequestBody } from '../src/serialize.ts'

/** One harness message of the given role and content. */
function message(role: 'user' | 'assistant' | 'system', content: ContentBlock[]): Message {
  return createMessage({ role, content, source: { kind: 'user' } } as Parameters<typeof createMessage>[0]) as Message
}

/** The wire messages `buildRequestBody` produced. */
function wire(messages: Message[], extra: Partial<GenerateOptions> = {}) {
  const body = buildRequestBody({ provider: 'blockrun', model: 'm', messages, ...extra } as GenerateOptions)
  return body['messages'] as { role: string; content?: string; tool_call_id?: string; tool_calls?: unknown[] }[]
}

const text = (value: string): ContentBlock => ({ type: 'text', text: value })

describe('buildRequestBody', () => {
  it('puts the system prompt in the system slot, first', () => {
    const out = wire([createUserMessage({ content: [text('hi')], source: { kind: 'user' } })], { system: 'be brief' })
    expect(out[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(out[1]?.role).toBe('user')
  })

  it('asks for usage on the terminal chunk', () => {
    const body = buildRequestBody({ provider: 'blockrun', model: 'm', messages: [] } as unknown as GenerateOptions)
    // Without this the harness has no provider-reported token accounting and
    // every downstream figure falls back to a heuristic.
    expect(body['stream']).toBe(true)
    expect(body['stream_options']).toEqual({ include_usage: true })
  })

  it('gives an empty tool result some content', () => {
    const out = wire([message('user', [{
      type: 'tool-result',
      toolCallId: CallId('c1'),
      content: [],
    }])])
    // A tool that succeeded while printing nothing is ordinary (chmod, mkdir).
    // An empty string reads as a malformed tool message to strict gateways.
    expect(out).toEqual([{ role: 'tool', tool_call_id: 'c1', content: '(no output)' }])
  })

  it('keeps user text that travels alongside a tool result', () => {
    const out = wire([message('user', [
      text('also, stop after this'),
      { type: 'tool-result', toolCallId: CallId('c1'), content: [text('done')] },
    ])])
    // Regression: an earlier build returned only the tool results, silently
    // deleting what the user actually said.
    expect(out).toEqual([
      { role: 'user', content: 'also, stop after this' },
      { role: 'tool', tool_call_id: 'c1', content: 'done' },
    ])
  })

  it('expands several tool results into one message each', () => {
    const out = wire([message('user', [
      { type: 'tool-result', toolCallId: CallId('a'), content: [text('1')] },
      { type: 'tool-result', toolCallId: CallId('b'), content: [text('2')] },
    ])])
    expect(out.map(m => m.tool_call_id)).toEqual(['a', 'b'])
  })

  it('sends a tool-call-only assistant turn with empty string content, never null', () => {
    const out = wire([message('assistant', [
      { type: 'tool-call', id: CallId('c1'), name: 'bash', arguments: '{"command":"ls"}' },
    ])])
    // Null content on an assistant turn is rejected outright by some gateways,
    // and the message sits durably in the session log — a null there would
    // break every later turn of that session, not just this request.
    expect(out[0]?.content).toBe('')
    expect(out[0]?.content).not.toBeNull()
    expect(out[0]?.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
    ])
  })

  it('passes tool-call arguments through as the raw JSON string', () => {
    const raw = '{"path":"/tmp/x","deep":{"n":1}}'
    const out = wire([message('assistant', [{ type: 'tool-call', id: CallId('c'), name: 't', arguments: raw }])])
    const call = (out[0]?.tool_calls as { function: { arguments: string } }[])[0]
    expect(call?.function.arguments).toBe(raw)
  })

  it('omits tool_calls entirely on a plain assistant turn', () => {
    const out = wire([message('assistant', [text('hello')])])
    expect(out[0]).toEqual({ role: 'assistant', content: 'hello' })
    expect('tool_calls' in (out[0] ?? {})).toBe(false)
  })

  it('drops prior-turn reasoning, which no request slot carries back', () => {
    const out = wire([message('assistant', [{ type: 'reasoning', text: 'thinking' }, text('answer')])])
    expect(out[0]?.content).toBe('answer')
  })

  it('refuses image content instead of silently dropping it', () => {
    const image = { type: 'image', attachment: { id: 'a' } } as unknown as ContentBlock
    // Silently dropping would send a request that reads as if the user never
    // attached anything, and the model would answer the wrong question.
    expect(() => wire([message('user', [image])])).toThrow(/does not yet send image content/)
  })

  it('carries only the generation options that were set', () => {
    const bare = buildRequestBody({ provider: 'p', model: 'm', messages: [] } as unknown as GenerateOptions)
    expect('temperature' in bare).toBe(false)
    expect('max_tokens' in bare).toBe(false)
    expect('stop' in bare).toBe(false)
    expect('tools' in bare).toBe(false)

    const full = buildRequestBody({
      provider: 'p',
      model: 'm',
      messages: [],
      temperature: 0.2,
      maxTokens: 64,
      stop: ['END'],
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
    } as unknown as GenerateOptions)
    expect(full['temperature']).toBe(0.2)
    expect(full['max_tokens']).toBe(64)
    expect(full['stop']).toEqual(['END'])
    expect(full['tools']).toEqual([{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object' } } }])
  })
})

import { describe, expect, it } from 'vitest'
import { CallId, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { buildRequestBody } from '../src/serialize.ts'
import type { ImageResolver } from '../src/serialize.ts'

/** One harness message of the given role and content. */
function message(role: 'user' | 'assistant' | 'system', content: ContentBlock[]): Message {
  return createMessage({ role, content, source: { kind: 'user' } } as Parameters<typeof createMessage>[0]) as Message
}

/** The wire messages `buildRequestBody` produced. */
async function wire(messages: Message[], extra: Partial<GenerateOptions> = {}, resolveImage?: ImageResolver) {
  const body = await buildRequestBody(
    { provider: 'blockrun', model: 'm', messages, ...extra } as GenerateOptions,
    resolveImage,
  )
  return body['messages'] as { role: string; content?: unknown; tool_call_id?: string; tool_calls?: unknown[] }[]
}

const text = (value: string): ContentBlock => ({ type: 'text', text: value })

describe('buildRequestBody', () => {
  it('puts the system prompt in the system slot, first', async () => {
    const out = await wire([createUserMessage({ content: [text('hi')], source: { kind: 'user' } })], { system: 'be brief' })
    expect(out[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(out[1]?.role).toBe('user')
  })

  it('asks for usage on the terminal chunk', async () => {
    const body = await buildRequestBody({ provider: 'blockrun', model: 'm', messages: [] } as unknown as GenerateOptions)
    // Without this the harness has no provider-reported token accounting and
    // every downstream figure falls back to a heuristic.
    expect(body['stream']).toBe(true)
    expect(body['stream_options']).toEqual({ include_usage: true })
  })

  it('gives an empty tool result some content', async () => {
    const out = await wire([message('user', [{
      type: 'tool-result',
      toolCallId: CallId('c1'),
      content: [],
    }])])
    // A tool that succeeded while printing nothing is ordinary (chmod, mkdir).
    // An empty string reads as a malformed tool message to strict gateways.
    expect(out).toEqual([{ role: 'tool', tool_call_id: 'c1', content: '(no output)' }])
  })

  it('keeps user text that travels alongside a tool result', async () => {
    const out = await wire([message('user', [
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

  it('expands several tool results into one message each', async () => {
    const out = await wire([message('user', [
      { type: 'tool-result', toolCallId: CallId('a'), content: [text('1')] },
      { type: 'tool-result', toolCallId: CallId('b'), content: [text('2')] },
    ])])
    expect(out.map(m => m.tool_call_id)).toEqual(['a', 'b'])
  })

  it('sends a tool-call-only assistant turn with empty string content, never null', async () => {
    const out = await wire([message('assistant', [
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

  it('passes tool-call arguments through as the raw JSON string', async () => {
    const raw = '{"path":"/tmp/x","deep":{"n":1}}'
    const out = await wire([message('assistant', [{ type: 'tool-call', id: CallId('c'), name: 't', arguments: raw }])])
    const call = (out[0]?.tool_calls as { function: { arguments: string } }[])[0]
    expect(call?.function.arguments).toBe(raw)
  })

  it('omits tool_calls entirely on a plain assistant turn', async () => {
    const out = await wire([message('assistant', [text('hello')])])
    expect(out[0]).toEqual({ role: 'assistant', content: 'hello' })
    expect('tool_calls' in (out[0] ?? {})).toBe(false)
  })

  it('drops prior-turn reasoning, which no request slot carries back', async () => {
    const out = await wire([message('assistant', [{ type: 'reasoning', text: 'thinking' }, text('answer')])])
    expect(out[0]?.content).toBe('answer')
  })

  describe('image content', () => {
    const ref = { attachmentId: 'a1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
    const image = { type: 'image', attachment: ref } as unknown as ContentBlock
    const resolve: ImageResolver = async () => 'data:image/png;base64,AAAA'

    it('carries a user image as an OpenAI content part', async () => {
      const out = await wire([message('user', [text('what is this?'), image])], {}, resolve)
      expect(out[0]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      })
    })

    it('leaves a text-only message as a bare string', async () => {
      // The parts array is used only when a message actually has an image.
      // Switching all traffic to it would be a wire change that gains nothing
      // and that gateways accept unevenly.
      const out = await wire([message('user', [text('hi')])], {}, resolve)
      expect(out[0]?.content).toBe('hi')
    })

    it('omits the text part when the message is only an image', async () => {
      const out = await wire([message('user', [image])], {}, resolve)
      expect(out[0]?.content).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }])
    })

    it('resolves several images concurrently, in order', async () => {
      const seen: string[] = []
      const slow: ImageResolver = async (r) => {
        seen.push(r.attachmentId as unknown as string)
        return `data:image/png;base64,${r.attachmentId}`
      }
      const second = { type: 'image', attachment: { ...ref, attachmentId: 'a2' } } as unknown as ContentBlock
      const out = await wire([message('user', [image, second])], {}, slow)
      expect(seen).toEqual(['a1', 'a2'])
      expect((out[0]?.content as { image_url: { url: string } }[]).map(p => p.image_url.url))
        .toEqual(['data:image/png;base64,a1', 'data:image/png;base64,a2'])
    })

    it('refuses an image when no attachment service is composed', async () => {
      // Silently dropping would send a request that reads as if the user never
      // attached anything, and the model would answer the wrong question.
      await expect(wire([message('user', [image])])).rejects.toThrow(/attachment service/)
    })

    it('refuses an image in an assistant turn, whose wire content is a string', async () => {
      await expect(wire([message('assistant', [image])], {}, resolve))
        .rejects.toThrow(/only user messages carry images/)
    })

    it('refuses an image inside a tool result', async () => {
      const withImage = message('user', [{ type: 'tool-result', toolCallId: CallId('c'), content: [image] }])
      await expect(wire([withImage], {}, resolve)).rejects.toThrow(/only user messages carry images/)
    })
  })

  it('carries only the generation options that were set', async () => {
    const bare = await buildRequestBody({ provider: 'p', model: 'm', messages: [] } as unknown as GenerateOptions)
    expect('temperature' in bare).toBe(false)
    expect('max_tokens' in bare).toBe(false)
    expect('stop' in bare).toBe(false)
    expect('tools' in bare).toBe(false)

    const full = await buildRequestBody({
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

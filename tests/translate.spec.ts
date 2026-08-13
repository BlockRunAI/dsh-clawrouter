import { describe, expect, it } from 'vitest'
import { StreamTranslator } from '../src/translate.ts'
import type { BlockrunStreamChunk } from '../src/types.ts'

/** Feed a whole response through one translator and collect every emitted chunk. */
function run(chunks: BlockrunStreamChunk[]) {
  const translator = new StreamTranslator()
  const out = chunks.flatMap(chunk => translator.accept(chunk))
  return [...out, ...translator.end()]
}

const textDelta = (text: string): BlockrunStreamChunk => ({ choices: [{ delta: { content: text } }] })

describe('StreamTranslator', () => {
  it('opens a block once and reuses its index for every delta', () => {
    const out = run([textDelta('Hel'), textDelta('lo'), { choices: [{ finish_reason: 'stop' }] }])
    expect(out.filter(chunk => chunk.type === 'block-start')).toHaveLength(1)
    const deltas = out.filter(chunk => chunk.type === 'text-delta')
    expect(deltas.map(chunk => chunk.index)).toEqual([0, 0])
    expect(out.find(chunk => chunk.type === 'block-end')?.block).toEqual({ type: 'text', text: 'Hello' })
  })

  it('emits usage before finish and nothing after it', () => {
    const out = run([
      textDelta('hi'),
      { choices: [{ finish_reason: 'stop' }] },
      // Trailing usage-only chunk: the shape that breaks a naive translator.
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
    ])
    const usageAt = out.findIndex(chunk => chunk.type === 'usage')
    const finishAt = out.findIndex(chunk => chunk.type === 'finish')
    expect(usageAt).toBeGreaterThanOrEqual(0)
    expect(usageAt).toBeLessThan(finishAt)
    expect(finishAt).toBe(out.length - 1)
    expect(out.filter(chunk => chunk.type === 'finish')).toHaveLength(1)
  })

  it('reports disjoint token buckets, subtracting cached tokens out of the prompt total', () => {
    const out = run([
      textDelta('hi'),
      {
        choices: [{ finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 900 },
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      },
    ])
    const usage = out.find(chunk => chunk.type === 'usage')
    // 1000 reported prompt tokens INCLUDE the 900 cached ones; the harness
    // requires them disjoint, so uncached input is 100 — not 1000.
    expect(usage?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 900,
      reasoningTokens: 30,
    })
  })

  it('keeps tool-call arguments as raw JSON streamed in fragments', () => {
    const out = run([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '{"cmd"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] } }] },
      { choices: [{ finish_reason: 'tool_calls' }] },
    ])
    const deltas = out.filter(chunk => chunk.type === 'tool-call-delta')
    expect(deltas.map(chunk => chunk.argumentsDelta)).toEqual(['{"cmd"', ':"ls"}'])
    // A later fragment carries no id or name; neither may be blanked.
    expect(deltas.every(chunk => chunk.id === 'call_1')).toBe(true)
    expect(out.find(chunk => chunk.type === 'block-end')?.block).toEqual({
      type: 'tool-call',
      id: 'call_1',
      name: 'bash',
      arguments: '{"cmd":"ls"}',
    })
    expect(out.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('gives interleaved reasoning and text their own blocks', () => {
    const out = run([
      { choices: [{ delta: { reasoning_content: 'think' } }] },
      textDelta('answer'),
      { choices: [{ finish_reason: 'stop' }] },
    ])
    const ends = out.filter(chunk => chunk.type === 'block-end')
    expect(ends.map(chunk => chunk.block)).toEqual([
      { type: 'reasoning', text: 'think' },
      { type: 'text', text: 'answer' },
    ])
    expect(ends[0]?.index).not.toBe(ends[1]?.index)
  })

  it('maps a truncated response to max-tokens', () => {
    const out = run([textDelta('partial'), { choices: [{ finish_reason: 'length' }] }])
    expect(out.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('throws rather than inventing a finish for a wholly empty stream', () => {
    const translator = new StreamTranslator()
    expect(() => translator.end()).toThrow(/empty stream/)
  })

  it('ignores chunks arriving after the stream was closed', () => {
    const translator = new StreamTranslator()
    translator.accept(textDelta('hi'))
    translator.end()
    expect(translator.accept(textDelta('late'))).toEqual([])
    expect(translator.end()).toEqual([])
  })
})

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

describe('a completed response with no content', () => {
  // Measured: both Anthropic models answer an image request this way through
  // the gateway — payment taken, `stop` reported, nothing streamed. Passing it
  // through as success hands the agent an empty assistant turn that reads as a
  // model with nothing to say, and nothing downstream can tell the difference.

  it('finishes with EMPTY_RESPONSE instead of a successful empty message', () => {
    const translator = new StreamTranslator()
    translator.accept({ choices: [{ delta: {}, finish_reason: 'stop' }] })
    const out = translator.end()
    const finish = out.find(chunk => chunk.type === 'finish')
    expect(finish).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' },
      },
    })
  })

  it('still reports usage before that finish, so the call is accounted for', () => {
    // The request was paid for whether or not it produced anything; dropping
    // the usage record would hide a charge that really happened.
    const translator = new StreamTranslator()
    translator.accept({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 0 } })
    const kinds = translator.end().map(chunk => chunk.type)
    expect(kinds).toEqual(['usage', 'finish'])
  })

  it('leaves a stop finish alone when content did arrive', () => {
    const translator = new StreamTranslator()
    translator.accept({ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] })
    const finish = translator.end().find(chunk => chunk.type === 'finish')
    expect(finish).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('leaves a non-stop finish alone even with no blocks', () => {
    // `length` with nothing emitted is a real, reportable outcome: the model
    // hit the cap before producing anything. Relabelling it would lose that.
    const translator = new StreamTranslator()
    translator.accept({ choices: [{ delta: {}, finish_reason: 'length' }] })
    const finish = translator.end().find(chunk => chunk.type === 'finish')
    expect(finish).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })
})

describe('an upstream error the gateway relayed as assistant text', () => {
  // Measured against the live gateway: an image request to
  // anthropic/claude-sonnet-5 or claude-opus-5 returns HTTP 200 and streams
  // the upstream 400 as the model's answer. Payment is taken, the harness sees
  // an ordinary successful turn, and the agent acts on the error string.
  const RELAYED = '\n\n[Error: 400 {"type":"error","error":{"type":"invalid_request_error",'
    + '"message":"Could not process image"},"request_id":"req_011"}]'

  it('finishes with a failure instead of handing the agent the error string', () => {
    const translator = new StreamTranslator()
    translator.accept({ choices: [{ delta: { content: RELAYED }, finish_reason: 'stop' }] })
    const finish = translator.end().find(chunk => chunk.type === 'finish') as {
      reason: { kind: string; failure?: { code: string; message: string } }
    }
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure?.code).toBe('INVALID_REQUEST')
    expect(finish.reason.failure?.message).toContain('Could not process image')
  })

  it('maps the relayed status the same way a real one would be', () => {
    const translator = new StreamTranslator()
    translator.accept({ choices: [{ delta: { content: '[Error: 429 {"message":"slow down"}]' }, finish_reason: 'stop' }] })
    const finish = translator.end().find(chunk => chunk.type === 'finish') as {
      reason: { failure?: { code: string } }
    }
    expect(finish.reason.failure?.code).toBe('RATE_LIMIT')
  })

  it('leaves an answer that merely mentions an error alone', () => {
    // The anchor is the whole point: a model explaining an error is ordinary
    // work, and relabelling it would break far more than it fixed.
    const translator = new StreamTranslator()
    translator.accept({ choices: [{
      delta: { content: 'You are seeing [Error: 400 {"a":1}] because the payload was malformed.' },
      finish_reason: 'stop',
    }] })
    const finish = translator.end().find(chunk => chunk.type === 'finish')
    expect(finish).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('leaves a response that also called a tool alone', () => {
    // Whatever its text says, a turn that called a tool did real work.
    const translator = new StreamTranslator()
    translator.accept({ choices: [{ delta: { content: '[Error: 400 {"x":1}]' }, finish_reason: null }] })
    translator.accept({ choices: [{
      delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'bash', arguments: '{}' } }] },
      finish_reason: 'stop',
    }] })
    const finish = translator.end().find(chunk => chunk.type === 'finish')
    expect((finish as { reason: { kind: string } }).reason.kind).toBe('stop')
  })
})

// Asserts what actually goes on the wire, over real HTTP, without spending
// anything: `@blockrun/llm` only runs the x402 handshake when a request comes
// back 402, so a local server answering 200 exercises the whole request path —
// serialization, model selection, streaming, translation — for free.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { BlockrunAdapter } from '../src/adapter.ts'
import { BlockrunCatalog } from '../src/catalog.ts'
import { SpendMeter } from '../src/spend.ts'

/** Valid-shaped key; no payment happens, so it is never used to sign anything. */
const DUMMY_KEY = `0x${'1'.repeat(64)}`

const CATALOG = {
  data: [
    { id: 'anthropic/claude-opus-5', name: 'Opus', categories: ['chat'], context_window: 200_000 },
    { id: 'deepseek/deepseek-chat', name: 'Flash', categories: ['chat'], context_window: 1_000_000 },
  ],
}

/** Every chat request body the server received, in order. */
let bodies: Record<string, unknown>[] = []
let server: ReturnType<typeof createServer> | undefined
let apiUrl = ''

beforeEach(async () => {
  bodies = []
  server = createServer((req, res) => {
    if (req.url?.endsWith('/models') === true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(CATALOG))
      return
    }
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  apiUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api`
})

afterEach(async () => {
  await new Promise<void>(resolve => server?.close(() => resolve()))
  server = undefined
})

/** An adapter pointed at the local server. */
function adapter(auxiliaryModel?: string, meter?: SpendMeter): BlockrunAdapter {
  return new BlockrunAdapter({
    provider: 'blockrun',
    connection: () => ({ apiUrl, timeoutMs: 10_000, ...auxiliaryModel === undefined ? {} : { auxiliaryModel } }),
    resolveWalletKey: () => Promise.resolve(DUMMY_KEY),
    catalog: new BlockrunCatalog('blockrun', `${apiUrl}/v1`),
    ...meter === undefined ? {} : { meter },
  })
}

/** Drive one request to completion. */
async function run(instance: BlockrunAdapter, extra: Partial<GenerateOptions> = {}): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of instance.stream({
    provider: 'blockrun',
    model: 'anthropic/claude-opus-5',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    ...extra,
  } as GenerateOptions)) {
    chunks.push(chunk)
  }
  return chunks
}

describe('what reaches the wire', () => {
  it('streams a plain request end to end over real HTTP', async () => {
    const chunks = await run(adapter())
    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.['model']).toBe('anthropic/claude-opus-5')
    expect(bodies[0]?.['stream']).toBe(true)
    expect(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')).toBe('ok')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('sends a compaction call to the auxiliary model', async () => {
    await run(adapter('deepseek/deepseek-chat'), { purpose: 'compaction' })
    // The whole point of the feature, asserted where it actually matters: the
    // model name that left this process.
    expect(bodies[0]?.['model']).toBe('deepseek/deepseek-chat')
  })

  it('sends a session-title call to the auxiliary model', async () => {
    await run(adapter('deepseek/deepseek-chat'), { purpose: 'session-title' })
    expect(bodies[0]?.['model']).toBe('deepseek/deepseek-chat')
  })

  it('never redirects a conversation request', async () => {
    await run(adapter('deepseek/deepseek-chat'))
    // A user who pinned Opus gets Opus. Auxiliary routing must not leak into
    // the conversation.
    expect(bodies[0]?.['model']).toBe('anthropic/claude-opus-5')
  })

  it('leaves maintenance calls alone when no auxiliary model is set', async () => {
    await run(adapter(), { purpose: 'compaction' })
    expect(bodies[0]?.['model']).toBe('anthropic/claude-opus-5')
  })

  it('rejects an auxiliary model the catalog does not serve, before sending anything', async () => {
    await expect(run(adapter('nope/not-real'), { purpose: 'compaction' })).rejects.toThrow(/UNKNOWN_MODEL|does not serve/)
    // The substituted model is validated like any other, so a typo in
    // auxiliaryModel fails loudly instead of breaking compaction at runtime.
    expect(bodies).toHaveLength(0)
  })
})

describe('spend metering through a real request', () => {
  it('counts a completed call, its tokens and its fee', async () => {
    const meter = new SpendMeter(0.001)
    await run(adapter(undefined, meter))

    // Asserted through the streaming path rather than by calling the meter
    // directly: the translator BUFFERS usage and emits it from end(), so an
    // adapter that watched only per-chunk output counted nothing while every
    // unit test of the meter itself still passed.
    const summary = meter.summary()
    expect(summary.calls).toBe(1)
    expect(summary.inputTokens).toBe(10)
    expect(summary.outputTokens).toBe(2)
    expect(summary.totalUsd).toBeCloseTo(0.001, 10)
  })

  it('counts nothing when no meter is attached', async () => {
    await run(adapter())
    expect(bodies).toHaveLength(1)
  })
})


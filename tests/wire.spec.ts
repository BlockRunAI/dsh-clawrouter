// Asserts what actually goes on the wire, over real HTTP, without spending
// anything: `@blockrun/llm` only runs the x402 handshake when a request comes
// back 402, so a local server answering 200 exercises the whole request path —
// serialization, model selection, streaming, translation — for free.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { BlockrunAdapter } from '../src/adapter.ts'
import { freeTierKey, requestFeeFor } from '../src/auth.ts'
import type { AuthRequest, AuthResolver, BlockrunAuth } from '../src/auth.ts'
import { BlockrunCatalog } from '../src/catalog.ts'
import { SpendMeter } from '../src/spend.ts'

/** Valid-shaped key; no payment happens, so it is never used to sign anything. */
const DUMMY_KEY = `0x${'1'.repeat(64)}`

const CATALOG = {
  data: [
    {
      id: 'anthropic/claude-opus-5',
      name: 'Opus',
      categories: ['chat'],
      context_window: 200_000,
      pricing: { input: 1, output: 2 },
    },
    { id: 'deepseek/deepseek-chat', name: 'Flash', categories: ['chat'], context_window: 1_000_000 },
    {
      id: 'nvidia/nemotron-3.5-lightning',
      name: 'Lightning',
      categories: ['chat'],
      billing_mode: 'free',
      pricing: { input: 0, output: 0 },
      context_window: 1_000_000,
    },
  ],
}

/**
 * A resolver standing in for a deployment that has configured no credential at
 * all — mirroring the production one in `src/index.ts`, which serves a free
 * model from a throwaway key and refuses anything that charges.
 */
function noCredential({ free }: AuthRequest): Promise<BlockrunAuth> {
  return free
    ? Promise.resolve({ mode: 'wallet', privateKey: freeTierKey(), apiUrl })
    : Promise.reject(new LlmError('no wallet key configured', 'MISSING_CREDENTIAL'))
}

/** Every chat request body the server received, in order. */
let bodies: Record<string, unknown>[] = []
/** The headers each of those requests carried, so a credential can be seen on the wire. */
let headers: Record<string, string | string[] | undefined>[] = []
let server: ReturnType<typeof createServer> | undefined
let apiUrl = ''
/** When set, the chat path answers with this status instead of streaming. */
let refuseWithStatus: number | undefined

beforeEach(async () => {
  bodies = []
  headers = []
  refuseWithStatus = undefined
  server = createServer((req, res) => {
    if (req.url?.endsWith('/models') === true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(CATALOG))
      return
    }
    if (refuseWithStatus !== undefined) {
      res.writeHead(refuseWithStatus, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Balance exhausted — add credit to continue' } }))
      return
    }
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      headers.push(req.headers)
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
function adapter(
  auxiliaryModel?: string,
  meter?: SpendMeter,
  resolveAuth: AuthResolver = () => Promise.resolve({ mode: 'wallet', privateKey: DUMMY_KEY, apiUrl }),
): BlockrunAdapter {
  return new BlockrunAdapter({
    provider: 'blockrun',
    connection: () => ({ apiUrl, timeoutMs: 10_000, ...auxiliaryModel === undefined ? {} : { auxiliaryModel } }),
    resolveAuth,
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


describe('the free tier does not ask for a wallet', () => {
  // Measured against the live gateway on 2026-08-30: an unpaid POST to
  // nvidia/nemotron-3.5-lightning returns HTTP 200, where the same POST to
  // deepseek/deepseek-chat returns 402. Free models never reach the x402
  // handshake, so requiring a funded wallet before one of them refused the
  // entire "no accounts, no API keys, try it now" path the route is for.

  it('dispatches a free model with no wallet configured at all', async () => {
    const chunks = await run(adapter(undefined, undefined, noCredential), { model: 'nvidia/nemotron-3.5-lightning' })
    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.['model']).toBe('nvidia/nemotron-3.5-lightning')
    expect(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')).toBe('ok')
  })

  it('still refuses a paid model with no wallet', async () => {
    // The exemption is per model, read from the catalog — not a general
    // loosening of the credential requirement.
    await expect(run(adapter(undefined, undefined, noCredential))).rejects.toThrow(/no wallet key configured/)
    expect(bodies).toHaveLength(0)
  })

  it('tells the resolver which calls are free, so a wallet is only asked for when one is needed', async () => {
    // The exemption is decided by the resolver, which is the only layer that
    // knows WHICH credential is configured: an account key must be sent even
    // for a free model, because api.blockrun.ai answers an unauthenticated
    // request 401 whatever it costs.
    const asked: boolean[] = []
    const counting = ({ free }: AuthRequest): Promise<BlockrunAuth> => {
      asked.push(free)
      return Promise.resolve({ mode: 'wallet', privateKey: DUMMY_KEY, apiUrl })
    }
    await run(adapter(undefined, undefined, counting), { model: 'nvidia/nemotron-3.5-lightning' })
    await run(adapter(undefined, undefined, counting))
    expect(asked).toEqual([true, false])
  })

  it('records a free call at $0 through the streaming path', async () => {
    const meter = new SpendMeter(0.002)
    await run(adapter(undefined, meter, noCredential), { model: 'nvidia/nemotron-3.5-lightning' })
    const summary = meter.summary()
    // The call happened and its tokens are counted; only the money is absent.
    expect(summary.calls).toBe(1)
    expect(summary.inputTokens).toBe(10)
    expect(summary.totalUsd).toBe(0)
    expect(summary.byModel[0]?.free).toBe(true)
  })

  it('routes a free auxiliary model without a wallet too', async () => {
    // auxiliaryModel is the one place the model that leaves this process is
    // not the one the caller named, so free-tier status has to be read from
    // the substituted id rather than the requested one.
    await run(adapter('nvidia/nemotron-3.5-lightning', undefined, noCredential), { purpose: 'compaction' })
    expect(bodies[0]?.['model']).toBe('nvidia/nemotron-3.5-lightning')
  })
})

describe('the model that answered is read off the wire', () => {
  // The gateway substitutes silently and the headers it sets for two of the
  // three cases do not reach us through the SDK, so the per-chunk `model`
  // field is the only signal there is. On this streaming path that field is
  // always a canonical BlockRun id for every provider — the vendor-versioned
  // ids and the composite "asked (fallback: served)" string belong to the
  // non-streaming endpoint, which this route never calls — so a mismatch is a
  // real substitution rather than a naming difference.

  /** Answer every chat request as `served`, whatever was asked for. */
  function substitute(served: string): void {
    server?.removeAllListeners('request')
    server?.on('request', (req, res) => {
      if (req.url?.endsWith('/models') === true) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(CATALOG))
        return
      }
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ model: served, choices: [{ delta: { content: 'ok' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ model: served, choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
  }

  it('records the substitute against the model that was requested', async () => {
    substitute('deepseek/deepseek-chat')
    const meter = new SpendMeter(0.002)
    await run(adapter(undefined, meter))
    const [entry] = meter.summary().byModel
    expect(entry?.model).toBe('anthropic/claude-opus-5')
    expect(entry?.servedBy).toEqual({ 'deepseek/deepseek-chat': 1 })
  })

  it('says nothing when the gateway serves what was asked for', async () => {
    substitute('anthropic/claude-opus-5')
    const meter = new SpendMeter(0.002)
    await run(adapter(undefined, meter))
    expect(meter.summary().byModel[0]?.servedBy).toBeUndefined()
  })

  it('is silent for a gateway that omits the field entirely', async () => {
    // The default server in this file sends no `model` at all, which is what
    // another OpenAI-compatible gateway behind a configured apiUrl may do.
    // Absence must not read as a substitution.
    const meter = new SpendMeter(0.002)
    await run(adapter(undefined, meter))
    expect(meter.summary().byModel[0]?.servedBy).toBeUndefined()
  })

  it('still delivers the answer the substitute produced', async () => {
    // Reporting the swap must not turn it into a failure: the reply is real
    // and the caller paid for it.
    substitute('deepseek/deepseek-chat')
    const chunks = await run(adapter())
    expect(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')).toBe('ok')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})

describe('an account key goes on the wire as a bearer token', () => {
  // The two credentials are not interchangeable and neither are their hosts:
  // a `brk_live_…` key sent to the wallet gateway is answered 402 rather than
  // served, and a wallet signature on the account host is answered 401. What
  // this asserts is that the credential the resolver picked is the one that
  // actually leaves the process.
  const withKey: AuthResolver = () =>
    Promise.resolve({ mode: 'api-key', apiKey: 'brk_live_test', apiUrl })

  it('sends Authorization and opens no x402 handshake', async () => {
    const chunks = await run(adapter(undefined, undefined, withKey))
    expect(headers[0]?.['authorization']).toBe('Bearer brk_live_test')
    expect(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')).toBe('ok')
  })

  it('sends the key for a free model too, because the account host demands one', async () => {
    // api.blockrun.ai answers an unauthenticated request 401 whatever the
    // model costs, so the wallet path's "free needs no credential" shortcut
    // does not carry over — and a call made on the account is a call the
    // account ledger can show.
    await run(adapter(undefined, undefined, withKey), { model: 'nvidia/nemotron-3.5-lightning' })
    expect(headers[0]?.['authorization']).toBe('Bearer brk_live_test')
  })

  it('prices the call from the catalog rather than at the per-request fee', async () => {
    const meter = new SpendMeter(0.002)
    await run(adapter(undefined, meter, withKey))
    const summary = meter.summary()
    expect(summary.basis).toBe('per-token')
    // The local catalog prices this model at $1/M in and $2/M out, and the
    // stub reports 10 in / 2 out.
    expect(summary.totalUsd).toBeCloseTo((10 / 1e6) * 1 + (2 / 1e6) * 2, 12)
  })

  it('leaves the wallet path on the per-request fee, untouched', async () => {
    const meter = new SpendMeter(0.002)
    await run(adapter(undefined, meter))
    expect(meter.summary().basis).toBe('per-request')
    expect(meter.summary().totalUsd).toBe(0.002)
    expect(headers[0]?.['authorization']).toBeUndefined()
  })
})

describe('a payment failure says what to do about it, per credential', () => {
  it('sends an account holder to the portal, and names no address', async () => {
    // The regression this pins: the wallet branch asked the SDK client for the
    // address to fund, and under an account key that call throws — account
    // billing derives no address at all. Reaching it from inside the catch
    // replaced an actionable payment failure with a TypeError from the SDK.
    //
    // The advice would be wrong even if it worked: an account is prepaid, and
    // USDC sent to any address on any chain cannot settle this call.
    refuseWithStatus = 402
    const instance = adapter(undefined, undefined, () =>
      Promise.resolve({ mode: 'api-key', apiKey: 'brk_live_test', apiUrl }))
    await expect(run(instance)).rejects.toThrow(/user\.blockrun\.ai\/dashboard\/credits/)
    await expect(run(instance)).rejects.not.toThrow(/Send USDC/)
  })

  it('still names the address a wallet has to be topped up at', async () => {
    refuseWithStatus = 402
    await expect(run(adapter())).rejects.toThrow(/Send USDC on Base to 0x[0-9a-fA-F]{40}/)
  })

  it('tells a free-tier caller the catalog went stale rather than asking for money', async () => {
    refuseWithStatus = 402
    await expect(run(adapter(undefined, undefined, noCredential), { model: 'nvidia/nemotron-3.5-lightning' }))
      .rejects.toThrow(/listed as a free model/)
  })

  it('reports an invalid account key as an auth failure, not a payment one', async () => {
    refuseWithStatus = 401
    const instance = adapter(undefined, undefined, () =>
      Promise.resolve({ mode: 'api-key', apiKey: 'brk_live_wrong', apiUrl }))
    await expect(run(instance)).rejects.toMatchObject({ code: 'AUTH' })
  })
})

describe('the Solana route is a different signer, not a different URL', () => {
  // An EIP-3009 authorization is not an SPL TransferChecked one, so this mode
  // drives SolanaLLMClient rather than pointing BlockrunClient at another
  // host. What these pin is that the adapter's own contract still holds across
  // the swap: the request reaches the wire, the fee is the one that chain
  // quotes, and a payment failure names the right chain.
  // A real, throwaway ed25519 keypair. It has to be a real one: deriving the
  // address the funding advice names checks that the public half matches the
  // private half, so a random 64-byte blob is rejected before the advice can
  // be written. Nothing is ever sent to it and it signs nothing here.
  const SOLANA_KEY =
    '4WMkvNz1ze2KxYEsX5dmmnKovcWk3PNjbDzASmKNbSWZjJtHhVRmQZ4BKnZ4WyvQ7yZdmeV3QWqkyZ31YoP3Xg35'
  const SOLANA_ADDRESS = '4duf4hLabXgwKKHYfaoPittRVoopCC2bDvygVnCDuGVH'
  const onSolana: AuthResolver = () =>
    Promise.resolve({ mode: 'solana-wallet', privateKey: SOLANA_KEY, apiUrl })

  it('streams a request through the Solana client', async () => {
    const chunks = await run(adapter(undefined, undefined, onSolana))
    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.['model']).toBe('anthropic/claude-opus-5')
    expect(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')).toBe('ok')
    // No bearer token: this gateway authenticates by signature, and it never
    // got as far as one here because the stub answered 200.
    expect(headers[0]?.['authorization']).toBeUndefined()
  })

  it('meters the call at the quote that chain actually gives', async () => {
    // Measured 2026-09-05: the same request is quoted 2000 µUSDC on Base and
    // 1000 on Solana. A meter holding one figure is wrong on one of them.
    const meter = new SpendMeter(0.002)
    await run(
      new BlockrunAdapter({
        provider: 'blockrun',
        connection: () => ({ apiUrl, timeoutMs: 10_000 }),
        resolveAuth: onSolana,
        catalog: new BlockrunCatalog('blockrun', `${apiUrl}/v1`),
        meter,
        requestFee: auth => requestFeeFor(auth),
      }),
    )
    expect(meter.summary().basis).toBe('per-request')
    expect(meter.summary().totalUsd).toBeCloseTo(0.001, 10)
  })

  it('keeps Base on its own quote through the same adapter', async () => {
    const meter = new SpendMeter(0.002)
    await run(
      new BlockrunAdapter({
        provider: 'blockrun',
        connection: () => ({ apiUrl, timeoutMs: 10_000 }),
        resolveAuth: () => Promise.resolve({ mode: 'wallet', privateKey: DUMMY_KEY, apiUrl }),
        catalog: new BlockrunCatalog('blockrun', `${apiUrl}/v1`),
        meter,
        requestFee: auth => requestFeeFor(auth),
      }),
    )
    expect(meter.summary().totalUsd).toBeCloseTo(0.002, 10)
  })

  it('names Solana, not Base, when the wallet cannot pay', async () => {
    // Sending Base USDC to a Solana address loses it. The chain in this
    // sentence is the difference between advice and a trap.
    refuseWithStatus = 402
    await expect(run(adapter(undefined, undefined, onSolana)))
      .rejects.toThrow(new RegExp(`Send USDC on Solana to ${SOLANA_ADDRESS}`))
  })

  it('leaves the meter to its own default when no per-chain fee is wired', async () => {
    // A caller that constructed SpendMeter(price) and wired no function said
    // what a request costs on their deployment; overriding that silently would
    // make the constructor argument a decoration.
    const meter = new SpendMeter(0.005)
    await run(adapter(undefined, meter, onSolana))
    expect(meter.summary().totalUsd).toBeCloseTo(0.005, 10)
  })
})

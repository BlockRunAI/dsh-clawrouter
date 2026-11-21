// End-to-end proof that the provider route mounts through the real Loader and
// that a missing wallet fails LOUD, naming the credential — rather than
// surfacing later as an opaque SDK constructor throw mid-turn.
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import Commands from '@deepseek-ai/dsh-commands'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import * as Clawrouter from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

// A local catalog, because the harness resolves a model through the seam
// before it ever calls `stream` — so these tests read a model list whether or
// not they get as far as dispatching anything. Serving it here keeps them
// offline and makes the entries they assert against fixed.
const CATALOG = {
  data: [
    { id: 'deepseek/deepseek-chat', name: 'Flash', categories: ['chat'], context_window: 1_000_000, billing_mode: 'paid' },
    {
      id: 'nvidia/nemotron-3.5-lightning',
      name: 'Lightning',
      categories: ['chat'],
      context_window: 1_000_000,
      billing_mode: 'free',
    },
  ],
}

let gateway: ReturnType<typeof createServer> | undefined
let apiUrl = ''
/** Every request the local gateway saw, so a credential can be watched on the wire. */
let seen: { url: string; authorization: string | undefined }[] = []

beforeEach(async () => {
  seen = []
  gateway = createServer((req, res) => {
    seen.push({ url: req.url ?? '', authorization: req.headers['authorization'] })
    if (req.url?.includes('/v1/usage/summary') === true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'usage_summary', totals: { usd: 0.0123, calls: 3, tokens: 900, unpriced_calls: 1 }, unavailable_days: [], counted_through: null }))
      return
    }
    if (req.url?.endsWith('/v1/credits') === true && req.headers['authorization']?.includes('REVOKED') === true) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }))
      return
    }
    if (req.url?.endsWith('/v1/credits') === true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ billing_mode: 'prepaid', granted_usd: 50, spent_usd: 8.8, remaining_usd: 41.2, blocked: false }))
      return
    }
    if (req.url?.endsWith('/models') === true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(CATALOG))
      return
    }
    // A chat request only reaches here in the tests that expect one; the rest
    // assert a failure raised before any dispatch.
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1 } })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await new Promise<void>(resolve => gateway!.listen(0, '127.0.0.1', resolve))
  apiUrl = `http://127.0.0.1:${(gateway!.address() as AddressInfo).port}/api`
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await new Promise<void>(resolve => gateway?.close(() => resolve()))
  gateway = undefined
})

/** Boot a real cordis.yml carrying the given adapter config lines. */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-clawrouter-adapter-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: 'dsh-clawrouter'",
    '  config:',
    ...configLines,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-commands', Commands],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['dsh-clawrouter', Clawrouter],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/** Drive one request to completion and return every chunk the seam exposed. */
async function drain(ctx: Context, provider: string): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream({
    provider,
    model: 'deepseek/deepseek-chat',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
  })) {
    chunks.push(chunk)
  }
  return chunks
}

/** The terminal failure code, when the stream ended in one. */
function failureCode(chunks: readonly StreamChunk[]): string | undefined {
  const finish = chunks.find(chunk => chunk.type === 'finish')
  if (finish?.type !== 'finish') return undefined
  return finish.reason.kind === 'error' || finish.reason.kind === 'aborted'
    ? finish.reason.failure.code
    : undefined
}

// Names no environment sets, so the "no credential" path is exercised
// regardless of what the machine running these tests happens to export. BOTH
// references have to be redirected: `apiKeyEnv` defaults to BLOCKRUN_API_KEY,
// which is exactly the variable a developer running these tests is likely to
// have exported, and picking it up would quietly turn every assertion below
// into one about someone's real account.
const ABSENT = [
  "    apiKeyEnv: 'DSH_CLAWROUTER_TEST_ABSENT_API_KEY'",
  "    solanaWalletKeyEnv: 'DSH_CLAWROUTER_TEST_ABSENT_SOLANA_KEY'",
  "    walletKeyEnv: 'DSH_CLAWROUTER_TEST_ABSENT_KEY'",
]

/** A real, throwaway Solana keypair; nothing is sent to it and it signs nothing. */
const SOLANA_KEY =
  '4WMkvNz1ze2KxYEsX5dmmnKovcWk3PNjbDzASmKNbSWZjJtHhVRmQZ4BKnZ4WyvQ7yZdmeV3QWqkyZ31YoP3Xg35'

/** Point the route at the local catalog above rather than the live gateway. */
function local(): string[] {
  return [`    apiUrl: '${apiUrl}'`]
}

describe('provider route, booted through the real Loader', () => {
  it('registers the blockrun route and reports its display name', async () => {
    const ctx = await boot(ABSENT)
    expect(ctx.llm.listProviders().map(p => p.id)).toContain('blockrun')
    expect(ctx.llm.listProviders().find(p => p.id === 'blockrun')?.name).toBe('BlockRun')
  }, 30_000)

  it('registers under a configured route name instead', async () => {
    const ctx = await boot([...ABSENT, "    provider: 'blockrun-solana'"])
    const ids = ctx.llm.listProviders().map(p => p.id)
    expect(ids).toContain('blockrun-solana')
    expect(ids).not.toContain('blockrun')
  }, 30_000)

  it('fails a request with MISSING_CREDENTIAL when neither credential is configured', async () => {
    const ctx = await boot([...ABSENT, ...local()])
    // Fails before any request is dispatched, naming both references — the
    // route takes an account key or a wallet key, and a diagnostic that named
    // only one would send half its readers down a path they did not want.
    // `deepseek/deepseek-chat` is a paid model, and a paid model is still
    // refused outright without a credential; only the free tier is exempt.
    expect(failureCode(await drain(ctx, 'blockrun'))).toBe('MISSING_CREDENTIAL')
  }, 30_000)

  it('fails with INVALID_CREDENTIAL when the wallet key is not a usable EVM key', async () => {
    process.env['DSH_CLAWROUTER_TEST_BAD_KEY'] = 'not-a-private-key'
    try {
      const ctx = await boot([
        "    apiKeyEnv: 'DSH_CLAWROUTER_TEST_ABSENT_API_KEY'",
        "    walletKeyEnv: 'DSH_CLAWROUTER_TEST_BAD_KEY'",
        ...local(),
      ])
      expect(failureCode(await drain(ctx, 'blockrun'))).toBe('INVALID_CREDENTIAL')
    } finally {
      delete process.env['DSH_CLAWROUTER_TEST_BAD_KEY']
    }
  }, 30_000)

  it('fails with INVALID_CREDENTIAL when a wallet key was pasted into the API-key reference', async () => {
    // The two variables sit next to each other in a shell profile and both
    // look like noise. Caught here it names the reference; sent on it is a
    // bare 401 from a host the reader did not know was involved.
    process.env['DSH_CLAWROUTER_TEST_BAD_API_KEY'] = `0x${'a'.repeat(64)}`
    try {
      const ctx = await boot(["    apiKeyEnv: 'DSH_CLAWROUTER_TEST_BAD_API_KEY'", ...local()])
      expect(failureCode(await drain(ctx, 'blockrun'))).toBe('INVALID_CREDENTIAL')
    } finally {
      delete process.env['DSH_CLAWROUTER_TEST_BAD_API_KEY']
    }
  }, 30_000)

  it('prefers the account key when both credentials are configured', async () => {
    // Order, not merge. Paying from a wallet that merely happens to be
    // exported would spend money on a call the reader put on the account, and
    // the SDK refuses both credentials at once anyway.
    process.env['DSH_CLAWROUTER_TEST_API_KEY'] = 'brk_live_composed'
    process.env['DSH_CLAWROUTER_TEST_WALLET_KEY'] = `0x${'1'.repeat(64)}`
    try {
      const ctx = await boot([
        "    apiKeyEnv: 'DSH_CLAWROUTER_TEST_API_KEY'",
        "    walletKeyEnv: 'DSH_CLAWROUTER_TEST_WALLET_KEY'",
        `    apiKeyUrl: '${apiUrl}'`,
        ...local(),
      ])
      expect(failureCode(await drain(ctx, 'blockrun'))).toBeUndefined()
      const chat = seen.filter(entry => entry.url.endsWith('/chat/completions'))
      expect(chat).toHaveLength(1)
      expect(chat[0]?.authorization).toBe('Bearer brk_live_composed')
    } finally {
      delete process.env['DSH_CLAWROUTER_TEST_API_KEY']
      delete process.env['DSH_CLAWROUTER_TEST_WALLET_KEY']
    }
  }, 30_000)

  it('reads the catalog from the account host, with the key attached', async () => {
    // api.blockrun.ai answers /v1/models 401 unauthenticated, so an anonymous
    // read would leave an API-key deployment with no model list at all — and
    // the account's listing is the sheet /spend then bills from.
    process.env['DSH_CLAWROUTER_TEST_API_KEY'] = 'brk_live_composed'
    try {
      const ctx = await boot([
        "    apiKeyEnv: 'DSH_CLAWROUTER_TEST_API_KEY'",
        `    apiKeyUrl: '${apiUrl}'`,
        "    apiUrl: 'https://blockrun.invalid/api'",
      ])
      expect((await ctx.llm.listModels('blockrun')).map(m => m.id)).toContain('deepseek/deepseek-chat')
      const catalogReads = seen.filter(entry => entry.url.endsWith('/models'))
      expect(catalogReads.length).toBeGreaterThan(0)
      expect(catalogReads[0]?.authorization).toBe('Bearer brk_live_composed')
    } finally {
      delete process.env['DSH_CLAWROUTER_TEST_API_KEY']
    }
  }, 30_000)

  it('prefers a Solana wallet over a Base one when both are configured', async () => {
    // Order, not merge. A deployment holding both wallets has said which
    // chains it CAN pay on, not which it prefers — and the two are quoted
    // differently, so which one answers is a decision, not a detail.
    process.env['DSH_CLAWROUTER_TEST_SOLANA_KEY'] = SOLANA_KEY
    process.env['DSH_CLAWROUTER_TEST_WALLET_KEY'] = `0x${'1'.repeat(64)}`
    try {
      const ctx = await boot([
        "    apiKeyEnv: 'DSH_CLAWROUTER_TEST_ABSENT_API_KEY'",
        "    solanaWalletKeyEnv: 'DSH_CLAWROUTER_TEST_SOLANA_KEY'",
        "    walletKeyEnv: 'DSH_CLAWROUTER_TEST_WALLET_KEY'",
        `    solanaApiUrl: '${apiUrl}'`,
        "    apiUrl: 'https://blockrun.invalid/api'",
      ])
      // Reaching the local gateway at all is the assertion: the Base root is a
      // hostname that does not resolve, so a request that went there fails.
      expect(failureCode(await drain(ctx, 'blockrun'))).toBeUndefined()
      expect(seen.some(entry => entry.url.endsWith('/chat/completions'))).toBe(true)
    } finally {
      delete process.env['DSH_CLAWROUTER_TEST_SOLANA_KEY']
      delete process.env['DSH_CLAWROUTER_TEST_WALLET_KEY']
    }
  }, 30_000)

  it('still prefers the account key over both wallets', async () => {
    process.env['DSH_CLAWROUTER_TEST_API_KEY'] = 'brk_live_composed'
    process.env['DSH_CLAWROUTER_TEST_SOLANA_KEY'] = SOLANA_KEY
    try {
      const ctx = await boot([
        "    apiKeyEnv: 'DSH_CLAWROUTER_TEST_API_KEY'",
        "    solanaWalletKeyEnv: 'DSH_CLAWROUTER_TEST_SOLANA_KEY'",
        `    apiKeyUrl: '${apiUrl}'`,
        "    solanaApiUrl: 'https://sol.blockrun.invalid/api'",
        ...local(),
      ])
      expect(failureCode(await drain(ctx, 'blockrun'))).toBeUndefined()
      const chat = seen.filter(entry => entry.url.endsWith('/chat/completions'))
      expect(chat[0]?.authorization).toBe('Bearer brk_live_composed')
    } finally {
      delete process.env['DSH_CLAWROUTER_TEST_API_KEY']
      delete process.env['DSH_CLAWROUTER_TEST_SOLANA_KEY']
    }
  }, 30_000)

  it('fails with INVALID_CREDENTIAL when a Base key was pasted into the Solana reference', async () => {
    // A valid secret of the wrong kind. Nothing downstream rejects it until a
    // payment call is already under way, and the message there does not name
    // the variable the reader has to fix.
    process.env['DSH_CLAWROUTER_TEST_WRONG_CHAIN'] = `0x${'a'.repeat(64)}`
    try {
      const ctx = await boot([
        "    apiKeyEnv: 'DSH_CLAWROUTER_TEST_ABSENT_API_KEY'",
        "    solanaWalletKeyEnv: 'DSH_CLAWROUTER_TEST_WRONG_CHAIN'",
        ...local(),
      ])
      expect(failureCode(await drain(ctx, 'blockrun'))).toBe('INVALID_CREDENTIAL')
    } finally {
      delete process.env['DSH_CLAWROUTER_TEST_WRONG_CHAIN']
    }
  }, 30_000)

  it('removes the route when the fiber is disposed', async () => {
    const ctx = await boot(ABSENT)
    const entry = [...ctx.loader.entries()].find(e => e.options.name === 'dsh-clawrouter')
    await entry?.fiber?.dispose()
    expect(ctx.llm.listProviders().map(p => p.id)).not.toContain('blockrun')
  }, 30_000)
})

/** A registered agent, which command listing is scoped to. */
function agent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('clawrouter-spend-agent')
  const session = Session.create(id)
  const value: Agent = {
    id, options: {}, session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

describe('/spend in the composed context', () => {
  it('registers, and reports nothing before any request', async () => {
    const ctx = await boot(ABSENT)
    const owner = agent(ctx)
    expect(ctx.commands.list(owner).map(c => c.name)).toContain('spend')

    const result = await ctx.commands.execute(owner, '/spend', [], new AbortController().signal)
    expect(result?.result.kind).toBe('success')
    // An empty meter says so rather than printing a confident $0 that could be
    // mistaken for "this route is free".
    expect(result?.result.kind === 'success' && result.result.text).toMatch(/No BlockRun requests yet/)
  }, 30_000)

  it('disappears when the fiber is disposed', async () => {
    const ctx = await boot(ABSENT)
    const owner = agent(ctx)
    const entry = [...ctx.loader.entries()].find(e => e.options.name === 'dsh-clawrouter')
    await entry?.fiber?.dispose()
    expect(ctx.commands.list(owner).map(c => c.name)).not.toContain('spend')
  }, 30_000)
})

describe('a key saved by `clawrouter login` is honoured', () => {
  // ClawRouter writes the account key to ~/.blockrun/.api-key for every
  // BlockRun product on the machine. Until 0.13.0 this route ignored it, so a
  // machine that was already logged in was told it had no credential.
  const SAVED_KEY = `brk_live_${'S'.repeat(40)}`

  /** Config lines pointing the route at a key file inside the test's own directory. */
  async function withSavedKey(content: string): Promise<string[]> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-clawrouter-keyfile-'))
    const path = join(dir, '.api-key')
    await writeFile(path, content, { mode: 0o600 })
    return [...ABSENT, `    apiKeyFiles: ['${path}']`, `    apiKeyUrl: '${apiUrl.replace(/\/api$/, '')}'`, ...local()]
  }

  it('sends the saved key as a bearer token when nothing is exported', async () => {
    const ctx = await boot(await withSavedKey(`${SAVED_KEY}\n`))
    const chunks = await drain(ctx, 'blockrun')
    expect(failureCode(chunks)).toBeUndefined()
    const chat = seen.filter(request => request.url.endsWith('/chat/completions'))
    expect(chat).toHaveLength(1)
    expect(chat[0]?.authorization).toBe(`Bearer ${SAVED_KEY}`)
  }, 30_000)

  it('lets the configured reference win over the saved file', async () => {
    const exported = `brk_live_${'E'.repeat(40)}`
    process.env['DSH_CLAWROUTER_TEST_API_KEY'] = exported
    try {
      const lines = (await withSavedKey(SAVED_KEY)).filter(line => !line.includes('apiKeyEnv'))
      const ctx = await boot([...lines, "    apiKeyEnv: 'DSH_CLAWROUTER_TEST_API_KEY'"])
      await drain(ctx, 'blockrun')
      const chat = seen.filter(request => request.url.endsWith('/chat/completions'))
      expect(chat[0]?.authorization).toBe(`Bearer ${exported}`)
    } finally {
      delete process.env['DSH_CLAWROUTER_TEST_API_KEY']
    }
  }, 30_000)

  it('refuses a saved file that does not hold a key, rather than falling through to a wallet', async () => {
    process.env['DSH_CLAWROUTER_TEST_WALLET'] = `0x${'1'.repeat(64)}`
    try {
      const lines = (await withSavedKey('not a key')).filter(line => !line.includes('walletKeyEnv'))
      const ctx = await boot([...lines, "    walletKeyEnv: 'DSH_CLAWROUTER_TEST_WALLET'"])
      // The wallet is right there and valid. Using it would spend USDC on a
      // call the reader had arranged to put on an account.
      expect(failureCode(await drain(ctx, 'blockrun'))).toBe('INVALID_CREDENTIAL')
      expect(seen.filter(request => request.url.endsWith('/chat/completions'))).toHaveLength(0)
    } finally {
      delete process.env['DSH_CLAWROUTER_TEST_WALLET']
    }
  }, 30_000)

  it('reads no file at all when apiKeyFiles is empty', async () => {
    const lines = (await withSavedKey(SAVED_KEY)).filter(line => !line.includes('apiKeyFiles'))
    const ctx = await boot([...lines, '    apiKeyFiles: []'])
    expect(failureCode(await drain(ctx, 'blockrun'))).toBe('MISSING_CREDENTIAL')
  }, 30_000)

  it('names the key and the account credit in /spend, without printing the key', async () => {
    const ctx = await boot(await withSavedKey(SAVED_KEY))
    const result = await ctx.commands.execute(agent(ctx), '/spend', [], new AbortController().signal)
    const text = result?.result.kind === 'success' ? result.result.text : ''
    expect(text).toMatch(/BlockRun account key brk_live_SSSSS…SSSS \(from .*\.api-key\)/)
    expect(text).toMatch(/Account credit: \$41\.20 remaining \(spent \$8\.80\)/)
    expect(text).not.toContain(SAVED_KEY)
    expect(seen.find(request => request.url.endsWith('/v1/credits'))?.authorization).toBe(`Bearer ${SAVED_KEY}`)
  }, 30_000)

  it('prints nothing about an account on a deployment that has none', async () => {
    const ctx = await boot([...ABSENT, '    apiKeyFiles: []', ...local()])
    const result = await ctx.commands.execute(agent(ctx), '/spend', [], new AbortController().signal)
    const text = result?.result.kind === 'success' ? result.result.text : ''
    expect(text).not.toMatch(/account/i)
    expect(seen.filter(request => request.url.endsWith('/v1/credits'))).toHaveLength(0)
  }, 30_000)
})

describe('/blockrun switches the credential the way `clawrouter login` does', () => {
  const KEY = `brk_live_${'L'.repeat(40)}`

  /** A deployment with no credential and a key file path that does not exist yet. */
  async function fresh(): Promise<{ lines: string[]; path: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-clawrouter-login-'))
    const path = join(dir, 'nested', '.api-key')
    return {
      path,
      lines: [...ABSENT, `    apiKeyFiles: ['${path}']`, `    apiKeyUrl: '${apiUrl.replace(/\/api$/, '')}'`, ...local()],
    }
  }

  /** `agent()` registers on every call, and these tests issue several commands per context. */
  const owners = new WeakMap<Context, Agent>()
  function owner(ctx: Context): Agent {
    const known = owners.get(ctx) ?? agent(ctx)
    owners.set(ctx, known)
    return known
  }

  async function command(ctx: Context, line: string): Promise<{ kind: string; text: string }> {
    const execution = await ctx.commands.execute(owner(ctx), line, [], new AbortController().signal)
    expect(execution, `${line} did not resolve`).toBeDefined()
    return execution!.result as { kind: string; text: string }
  }

  it('saves a key the host accepts, owner-readable only, and the next request uses it', async () => {
    const { lines, path } = await fresh()
    const ctx = await boot(lines)
    expect(failureCode(await drain(ctx, 'blockrun'))).toBe('MISSING_CREDENTIAL')

    const result = await command(ctx, `/blockrun login ${KEY}`)
    expect(result.kind).toBe('success')
    expect(result.text).toMatch(/Account credit: \$41\.20 remaining/)
    expect(result.text).not.toContain(KEY)
    expect((await readFile(path, 'utf8')).trim()).toBe(KEY)
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    // No reload: the credential is resolved per request.
    expect(failureCode(await drain(ctx, 'blockrun'))).toBeUndefined()
    expect(seen.filter(request => request.url.endsWith('/chat/completions')).at(-1)?.authorization).toBe(`Bearer ${KEY}`)
  }, 30_000)

  it('does not save a key the host rejects', async () => {
    const { lines, path } = await fresh()
    const ctx = await boot(lines)
    const result = await command(ctx, `/blockrun login brk_live_REVOKED${'x'.repeat(30)}`)
    expect(result.kind).toBe('error')
    expect(result.text).toMatch(/rejected/)
    await expect(stat(path)).rejects.toThrow()
  }, 30_000)

  it('refuses something that is not a BlockRun key before sending it anywhere', async () => {
    const { lines, path } = await fresh()
    const ctx = await boot(lines)
    const before = seen.length
    const result = await command(ctx, `/blockrun login 0x${'a'.repeat(64)}`)
    expect(result.kind).toBe('error')
    expect(seen.slice(before).filter(request => request.url.endsWith('/v1/credits'))).toHaveLength(0)
    await expect(stat(path)).rejects.toThrow()
  }, 30_000)

  it('logs out by removing the file, and the route goes back to having no credential', async () => {
    const { lines, path } = await fresh()
    const ctx = await boot(lines)
    await command(ctx, `/blockrun login ${KEY}`)
    const result = await command(ctx, '/blockrun logout')
    expect(result.text).toMatch(/Removed/)
    await expect(stat(path)).rejects.toThrow()
    expect(failureCode(await drain(ctx, 'blockrun'))).toBe('MISSING_CREDENTIAL')
  }, 30_000)

  it('reports the credential in use, and says so plainly when there is none', async () => {
    const { lines } = await fresh()
    const ctx = await boot(lines)
    expect((await command(ctx, '/blockrun')).text).toMatch(/No BlockRun credential/)
    await command(ctx, `/blockrun login ${KEY}`)
    const status = (await command(ctx, '/blockrun status')).text
    expect(status).toMatch(/BlockRun account key brk_live_LLLLL…LLLL/)
    expect(status).toMatch(/Account credit/)
  }, 30_000)

  it('keeps the key out of the session log', async () => {
    const { lines } = await fresh()
    const ctx = await boot(lines)
    const definition = ctx.commands.find(owner(ctx), 'blockrun')
    // `command/run` records the raw argument unless the definition opts out,
    // and the argument to `login` is a bearer credential.
    expect(definition?.recordInput).toBe(false)
  }, 30_000)

  it('puts the account ledger beside what this process counted in /spend', async () => {
    const { lines } = await fresh()
    const ctx = await boot(lines)
    await command(ctx, `/blockrun login ${KEY}`)
    await drain(ctx, 'blockrun')
    const text = (await command(ctx, '/spend')).text
    expect(text).toMatch(/Account ledger since this process started: \$0\.0123 across 3 calls — this process recorded \$\S+ across 1 on this key\./)
    expect(text).toMatch(/2 of those were not made here/)
    expect(text).toMatch(/1 ledger call is not priced yet/)
    expect(text).not.toMatch(/different account key/)
  }, 30_000)

  it('compares the ledger only with calls billed to the same key after switching accounts', async () => {
    // Codex review, 2026-11-21: ten calls on account A then one on B compared
    // B's ledger with all eleven and reported a lag that was not there.
    const { lines } = await fresh()
    const ctx = await boot(lines)
    await command(ctx, `/blockrun login ${KEY}`)
    await drain(ctx, 'blockrun')
    await drain(ctx, 'blockrun')
    await command(ctx, `/blockrun login brk_live_${'B'.repeat(40)}`)
    await drain(ctx, 'blockrun')
    const text = (await command(ctx, '/spend')).text
    expect(text).toMatch(/this process recorded \$\S+ across 1 on this key\./)
    expect(text).toMatch(/2 calls this process billed to a different account key are not part of this comparison/)
    // The stub ledger holds 3 calls and this key made 1, so 2 came from
    // elsewhere. It must NOT say the ledger is behind, which the mixed total did.
    expect(text).not.toMatch(/ledger is behind/)
  }, 30_000)

  it('reports a broken saved key file as blocking, not as a wallet fallback', async () => {
    // Codex review, 2026-11-21: status described a wallet the request path
    // would never use, because the credential error was swallowed.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-clawrouter-broken-'))
    const path = join(dir, '.api-key')
    await writeFile(path, 'not a key')
    process.env['DSH_CLAWROUTER_TEST_WALLET'] = `0x${'1'.repeat(64)}`
    try {
      const ctx = await boot([
        "    apiKeyEnv: 'DSH_CLAWROUTER_TEST_ABSENT_API_KEY'",
        "    solanaWalletKeyEnv: 'DSH_CLAWROUTER_TEST_ABSENT_SOLANA_KEY'",
        "    walletKeyEnv: 'DSH_CLAWROUTER_TEST_WALLET'",
        `    apiKeyFiles: ['${path}']`,
        ...local(),
      ])
      const status = await command(ctx, '/blockrun')
      expect(status.kind).toBe('error')
      expect(status.text).toContain(path)
      expect(status.text).toMatch(/a wallet is not used in its place/)
      expect(status.text).not.toMatch(/Paying per call from/)
      // The request path agrees with what status said.
      expect(failureCode(await drain(ctx, 'blockrun'))).toBe('INVALID_CREDENTIAL')
      // /spend stays best-effort but says why paid calls fail.
      expect((await command(ctx, '/spend')).text).toMatch(/account key cannot be used/)
    } finally {
      delete process.env['DSH_CLAWROUTER_TEST_WALLET']
    }
  }, 30_000)
})

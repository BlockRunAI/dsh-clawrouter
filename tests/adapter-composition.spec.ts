// End-to-end proof that the provider route mounts through the real Loader and
// that a missing wallet fails LOUD, naming the credential — rather than
// surfacing later as an opaque SDK constructor throw mid-turn.
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

beforeEach(async () => {
  gateway = createServer((req, res) => {
    // Only the catalog is served. A request that reaches the chat path has
    // already failed the assertion it was written for.
    res.writeHead(req.url?.endsWith('/models') === true ? 200 : 500, { 'content-type': 'application/json' })
    res.end(JSON.stringify(CATALOG))
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

// A name no environment sets, so the "no wallet" path is exercised regardless
// of what the machine running these tests happens to export.
const ABSENT = ["    walletKeyEnv: 'DSH_CLAWROUTER_TEST_ABSENT_KEY'"]

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

  it('fails a request with MISSING_CREDENTIAL when no wallet is configured', async () => {
    const ctx = await boot([...ABSENT, ...local()])
    // Fails before any request is dispatched, naming the reference — BlockRun
    // has no API key to paste, so the diagnostic has to say what to set
    // instead. `deepseek/deepseek-chat` is a paid model, and a paid model is
    // still refused outright without a key; only the free tier is exempt.
    expect(failureCode(await drain(ctx, 'blockrun'))).toBe('MISSING_CREDENTIAL')
  }, 30_000)

  it('fails with INVALID_CREDENTIAL when the wallet key is not a usable EVM key', async () => {
    process.env['DSH_CLAWROUTER_TEST_BAD_KEY'] = 'not-a-private-key'
    try {
      const ctx = await boot(["    walletKeyEnv: 'DSH_CLAWROUTER_TEST_BAD_KEY'", ...local()])
      expect(failureCode(await drain(ctx, 'blockrun'))).toBe('INVALID_CREDENTIAL')
    } finally {
      delete process.env['DSH_CLAWROUTER_TEST_BAD_KEY']
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

    const result = await ctx.commands.execute(owner, '/spend', new AbortController().signal)
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

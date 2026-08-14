// End-to-end proof that the provider route mounts through the real Loader and
// that a missing wallet fails LOUD, naming the credential — rather than
// surfacing later as an opaque SDK constructor throw mid-turn.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
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

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
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
    const ctx = await boot(ABSENT)
    // Fails before any network I/O, naming the reference — BlockRun has no API
    // key to paste, so the diagnostic has to say what to set instead.
    expect(failureCode(await drain(ctx, 'blockrun'))).toBe('MISSING_CREDENTIAL')
  }, 30_000)

  it('fails with INVALID_CREDENTIAL when the wallet key is not a usable EVM key', async () => {
    process.env['DSH_CLAWROUTER_TEST_BAD_KEY'] = 'not-a-private-key'
    try {
      const ctx = await boot(["    walletKeyEnv: 'DSH_CLAWROUTER_TEST_BAD_KEY'"])
      expect(failureCode(await drain(ctx, 'blockrun'))).toBe('INVALID_CREDENTIAL')
    } finally {
      delete process.env['DSH_CLAWROUTER_TEST_BAD_KEY']
    }
  }, 30_000)

  it('removes the route when the fiber is disposed', async () => {
    const ctx = await boot(ABSENT)
    const entry = ctx.loader.entries().find(e => e.options.name === 'dsh-clawrouter')
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
    const entry = ctx.loader.entries().find(e => e.options.name === 'dsh-clawrouter')
    await entry?.fiber?.dispose()
    expect(ctx.commands.list(owner).map(c => c.name)).not.toContain('spend')
  }, 30_000)
})

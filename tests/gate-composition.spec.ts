// End-to-end proof of the plugin's central safety claim: a dangerous tool call
// is DENIED by the real tool executor, in a composition booted through the real
// cordis Loader from a real cordis.yml — not merely discouraged in a prompt.
//
// The reviewer is a stub adapter registered on the real `ctx.llm` seam, so the
// gate's own code path (risk match -> model request -> verdict -> decision) runs
// unchanged; only the model behind it is deterministic.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import Commands from '@deepseek-ai/dsh-commands'
import * as Review from '../src/review.ts'

let root: string | undefined
let context: Context | undefined
/** Every prompt the stub reviewer was asked, so "was it consulted?" is observable. */
let asked: string[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  asked = []
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** How the stub reviewer should behave for one test. */
type ReviewerBehavior = { kind: 'reply'; text: string } | { kind: 'throw' } | { kind: 'hang' }

let behavior: ReviewerBehavior = { kind: 'reply', text: '{"ruling":"safe","reason":"ok"}' }

/** A deterministic stand-in for the reviewer model, registered on the real llm seam. */
class StubAdapter extends LlmAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    asked.push(options.messages.map(m => m.content.map(b => b.type === 'text' ? b.text : '').join('')).join('\n'))
    if (behavior.kind === 'throw') throw new Error('reviewer offline')
    if (behavior.kind === 'hang') {
      // Settles only on abort. The `aborted` check is not belt-and-braces: by
      // the time a cancelled call reaches an adapter the signal is usually
      // already aborted, and a listener added then never fires — which is the
      // very bug this test exists to catch.
      await new Promise<void>((resolve) => {
        const signal = options.signal
        if (signal === undefined || signal.aborted) return resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      throw new Error('reviewer aborted')
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: behavior.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: behavior.text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Mounts the stub reviewer route and a `bash` tool that records whether it ran. */
const ran: string[] = []

/** Set when a test wants a stricter policy listener sitting after the gate. */
let downstreamDenies = false
const DOWNSTREAM_REASON = 'denied by the deployment policy'

/** A policy listener mounted AFTER the gate, so the gate must delegate to reach it. */
const Downstream = {
  name: 'clawrouter-test-downstream',
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.on('tools/pre-execute', async (_exec, next) => {
      if (downstreamDenies) return { kind: 'deny' as const, reason: DOWNSTREAM_REASON }
      return next()
    })
  },
}
const Fixture = {
  name: 'clawrouter-test-fixture',
  inject: ['llm', 'tools'],
  apply(ctx: Context) {
    ctx.llm.registerAdapter(['stub'], new StubAdapter())
    ctx.tools.register(defineTool({
      name: 'bash',
      description: 'Run a shell command.',
      parameters: { command: { type: 'string', required: true, description: 'the command' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        // Reaching here means the gate let the call through to real execution.
        ran.push(args.command)
        return `executed: ${args.command}`
      },
    }))
  },
}

let agentSeq = 0

function agent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  // Unique per call: the registry rejects a duplicate id, and one test needs
  // two agents in the same composition.
  const id = SessionId(`clawrouter-gate-agent-${agentSeq++}`)
  const session = Session.create(id)
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

/**
 * Boot a real cordis.yml carrying the given review config lines.
 * @param configLines - YAML lines nested under the plugin's `config:` key.
 * @param withCommands - whether the composition provides a command surface.
 */
async function boot(configLines: readonly string[], withCommands = true): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-clawrouter-gate-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-llm'",
    ...withCommands ? ["- name: '@deepseek-ai/dsh-commands'"] : [],
    "- name: 'clawrouter-test-fixture'",
    "- name: 'dsh-clawrouter/review'",
    '  config:',
    ...configLines,
    "- name: 'clawrouter-test-downstream'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-commands', Commands],
    ['clawrouter-test-fixture', Fixture],
    ['dsh-clawrouter/review', Review],
    ['clawrouter-test-downstream', Downstream],
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

const ENABLED = ['    enabled: true', "    reviewerProvider: 'stub'", "    reviewerModel: 'stub-reviewer'"]

/** Run one bash call through the real executor. */
async function callBash(ctx: Context, command: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`call-${ran.length}-${asked.length}`),
    name: 'bash',
    arguments: { command },
    agent: agent(ctx),
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('review gate, booted through the real Loader', () => {
  it('DENIES a dangerous command through the executor, and it never runs', async () => {
    behavior = { kind: 'reply', text: '{"ruling":"dangerous","reason":"This erases your home directory."}' }
    ran.length = 0
    const ctx = await boot(ENABLED)

    const result = await callBash(ctx, 'rm -rf ~')

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('erases your home directory')
    // The claim that matters: enforcement is in the executor, so the tool body
    // was never reached. A prompt-level warning could not produce this.
    expect(ran).toEqual([])
  }, 30_000)

  it('lets a reviewed-safe command through to real execution', async () => {
    behavior = { kind: 'reply', text: '{"ruling":"safe","reason":"Scoped to build output."}' }
    ran.length = 0
    const ctx = await boot(ENABLED)

    const result = await callBash(ctx, 'rm -rf ./dist')

    expect(result.isError).toBe(false)
    expect(ran).toEqual(['rm -rf ./dist'])
    expect(asked).toHaveLength(1)
  }, 30_000)

  it('never consults the reviewer for ordinary work', async () => {
    behavior = { kind: 'reply', text: '{"ruling":"dangerous","reason":"should not be asked"}' }
    ran.length = 0
    const ctx = await boot(ENABLED)

    const result = await callBash(ctx, 'ls -la')

    expect(result.isError).toBe(false)
    expect(ran).toEqual(['ls -la'])
    // Not merely allowed — not even reviewed. This is what keeps the gate cheap
    // and keeps users from switching it off.
    expect(asked).toEqual([])
  }, 30_000)

  it('does not run a dangerous command when the reviewer is unreachable', async () => {
    behavior = { kind: 'throw' }
    ran.length = 0
    const ctx = await boot(ENABLED)

    const result = await callBash(ctx, 'rm -rf /')

    // Escalated to a human approver; with no approval service composed, `ask`
    // resolves to a denial. Either way the command must not execute — a safety
    // gate that fails OPEN would be worse than having none at all.
    expect(result.isError).toBe(true)
    expect(ran).toEqual([])
  }, 30_000)

  it('stays out of the way entirely while disabled', async () => {
    behavior = { kind: 'reply', text: '{"ruling":"dangerous","reason":"should not be asked"}' }
    ran.length = 0
    const ctx = await boot(['    enabled: false', "    reviewerProvider: 'stub'"])

    const result = await callBash(ctx, 'rm -rf ~')

    expect(result.isError).toBe(false)
    expect(ran).toEqual(['rm -rf ~'])
    expect(asked).toEqual([])
  }, 30_000)

  it('registers the /review command in the composed context', async () => {
    const ctx = await boot(ENABLED)
    const owner = agent(ctx)
    expect(ctx.commands.list(owner).map(c => c.name)).toContain('review')
  }, 30_000)

  it('still guards a composition that has no command surface', async () => {
    behavior = { kind: 'reply', text: '{"ruling":"dangerous","reason":"This erases your home directory."}' }
    ran.length = 0
    const ctx = await boot(ENABLED, false)

    // `commands` is an optional UI seam. A safety gate that failed to mount
    // without it would silently stop protecting exactly the headless and
    // automation compositions that most need it.
    expect(ctx.get('commands')).toBeUndefined()
    const result = await callBash(ctx, 'rm -rf ~')
    expect(result.isError).toBe(true)
    expect(ran).toEqual([])
  }, 30_000)

  it('unregisters everything when the fiber is disposed', async () => {
    behavior = { kind: 'reply', text: '{"ruling":"dangerous","reason":"nope"}' }
    ran.length = 0
    const ctx = await boot(ENABLED)
    const owner = agent(ctx)
    expect(ctx.commands.list(owner).map(c => c.name)).toContain('review')

    const entry = [...ctx.loader.entries()].find(e => e.options.name === 'dsh-clawrouter/review')
    await entry?.fiber?.dispose()

    expect(ctx.commands.list(owner).map(c => c.name)).not.toContain('review')
    const result = await callBash(ctx, 'rm -rf ~')
    expect(result.isError).toBe(false)
    expect(ran).toEqual(['rm -rf ~'])
  }, 30_000)
})

describe('the gate only ever narrows', () => {
  it('defers to a stricter listener instead of escalating past it', async () => {
    // Reviewer is unsure, so the gate would escalate to a human. But a policy
    // listener AFTER it denies outright. Returning `ask` here would skip that
    // listener entirely, and a human clicking Allow would run a call the
    // deployment had already refused.
    behavior = { kind: 'reply', text: '{"ruling":"uncertain","reason":"cannot tell from here"}' }
    downstreamDenies = true
    ran.length = 0
    const ctx = await boot(ENABLED)

    const result = await callBash(ctx, 'rm -rf ~')

    expect(result.isError).toBe(true)
    expect(text(result)).toContain(DOWNSTREAM_REASON)
    expect(ran).toEqual([])
    downstreamDenies = false
  }, 30_000)

  it('still escalates when the rest of the chain would have allowed', async () => {
    behavior = { kind: 'reply', text: '{"ruling":"uncertain","reason":"cannot tell from here"}' }
    downstreamDenies = false
    ran.length = 0
    const ctx = await boot(ENABLED)

    const result = await callBash(ctx, 'rm -rf ~')

    // No approval service is composed, so an escalation resolves to a denial —
    // what matters is that the command did not run and the reason is the
    // reviewer's, not a downstream listener's.
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('cannot tell from here')
    expect(ran).toEqual([])
  }, 30_000)

  it('lets a stricter listener win even on a reviewed-safe call', async () => {
    behavior = { kind: 'reply', text: '{"ruling":"safe","reason":"looks fine"}' }
    downstreamDenies = true
    ran.length = 0
    const ctx = await boot(ENABLED)

    const result = await callBash(ctx, 'rm -rf ./dist')

    expect(result.isError).toBe(true)
    expect(text(result)).toContain(DOWNSTREAM_REASON)
    expect(ran).toEqual([])
    downstreamDenies = false
  }, 30_000)
})

describe('a cancelled turn', () => {
  it('does not prompt a human for a call nobody is waiting for', async () => {
    // The reviewer hangs; the caller cancels while it is in flight. That
    // failure says nothing about the command, and the turn is going away —
    // escalating would put an approval prompt on screen for a cancelled call.
    behavior = { kind: 'hang' }
    ran.length = 0
    const ctx = await boot(ENABLED)
    const controller = new AbortController()

    const pending = ctx.tools.execute({
      signal: controller.signal,
      callId: CallId('cancelled-call'),
      name: 'bash',
      arguments: { command: 'rm -rf ~' },
      agent: agent(ctx),
    })
    controller.abort(new Error('user cancelled the turn'))
    const result = await pending

    expect(result.isError).toBe(true)
    expect(ran).toEqual([])
    behavior = { kind: 'reply', text: '{"ruling":"safe","reason":"ok"}' }
  }, 30_000)
})

describe('a misconfigured reviewer', () => {
  it('says so, instead of quietly turning into "ask a human about everything"', async () => {
    // A reviewer naming a model that does not exist fails on every risky
    // command. Downstream that is indistinguishable from the gate working
    // cautiously — the approval prompt shows the harness's own wording, not
    // the verdict reason — so the only place the mistake can surface is a log.
    // A provider route nothing registered, so the real llm runtime produces
    // the real failure (NO_ADAPTER) rather than a synthetic throw.
    ran.length = 0
    const ctx = await boot(['    enabled: true', "    reviewerProvider: 'not-registered'", "    reviewerModel: 'x'"])
    const errors: string[] = []
    const original = ctx.logger.error.bind(ctx.logger)
    ctx.logger.error = ((value: unknown) => {
      errors.push(typeof value === 'string' ? value : String(value))
      return original(value as never)
    }) as typeof ctx.logger.error

    await callBash(ctx, 'rm -rf ~')

    expect(errors.some(line => /reviewer .* cannot be used/.test(line))).toBe(true)
    expect(errors.some(line => /reviewerModel and reviewerProvider/.test(line))).toBe(true)
    expect(ran).toEqual([])
  }, 30_000)

  it('reports it once, not on every flagged command', async () => {
    const ctx = await boot(['    enabled: true', "    reviewerProvider: 'not-registered'", "    reviewerModel: 'x'"])
    const errors: string[] = []
    const original = ctx.logger.error.bind(ctx.logger)
    ctx.logger.error = ((value: unknown) => {
      if (typeof value === 'string') errors.push(value)
      return original(value as never)
    }) as typeof ctx.logger.error

    for (let i = 0; i < 3; i++) await callBash(ctx, 'rm -rf ~')

    // Repeating an identical warning per call buries the one that matters.
    expect(errors.filter(line => /cannot be used/.test(line))).toHaveLength(1)
  }, 30_000)
})

describe('/gate reports whether the net is actually up', () => {
  /** Run `/gate` in a composed context and return the rendered text. */
  async function runGate(ctx: Context, input = ''): Promise<string> {
    const owner = agent(ctx)
    const command = ctx.commands.list(owner).find(entry => entry.name === 'gate')
    expect(command, '/gate is not registered').toBeDefined()
    const line = input.length === 0 ? '/gate' : `/gate ${input}`
    const execution = await ctx.commands.execute(owner, line, AbortSignal.timeout(20_000))
    expect(execution, `command surface did not run ${line}`).toBeDefined()
    const result = execution!.result as { text?: string }
    return result.text ?? ''
  }

  it('is registered even when the gate is disabled', async () => {
    // The whole reason this command exists. `/review` registers either way, so
    // a user who mis-edited their patch layer sees a working command and
    // concludes the gate is on; the only honest answer has to come from a
    // command that is present precisely when nothing is being reviewed.
    const ctx = await boot(['    enabled: false'])
    const owner = agent(ctx)
    expect(ctx.commands.list(owner).map(entry => entry.name)).toContain('gate')
  }, 30_000)

  it('says NOT ARMED, and says a working /review proves nothing', async () => {
    const ctx = await boot(['    enabled: false'])
    const text = await runGate(ctx)
    expect(text).toContain('NOT ARMED')
    expect(text).toContain('/review')
    expect(text).toContain('enabled: true')
  }, 30_000)

  it('says ARMED and names the reviewer actually in use', async () => {
    const ctx = await boot(ENABLED)
    const text = await runGate(ctx)
    expect(text).toContain('ARMED')
    expect(text).not.toContain('NOT ARMED')
  }, 30_000)

  it('refuses to drill a gate that is not armed', async () => {
    const ctx = await boot(['    enabled: false'])
    const text = await runGate(ctx, 'drill')
    expect(text).toMatch(/not armed/i)
    expect(asked, 'a disarmed drill must not spend a reviewer call').toEqual([])
  }, 30_000)

  it('drills end to end and reports the reviewer denying the command', async () => {
    behavior = { kind: 'reply', text: '{"ruling":"dangerous","reason":"This erases the filesystem."}' }
    ran.length = 0
    const ctx = await boot(ENABLED)
    const text = await runGate(ctx, 'drill')
    expect(text).toContain('risk matcher')
    expect(text).toContain('dangerous')
    expect(text).toContain('would have been denied')
    expect(asked, 'the drill must consult the real reviewer path').toHaveLength(1)
    expect(ran, 'the drill must never execute its own command').toEqual([])
  }, 30_000)

  it('reports an unreachable reviewer as unreachable, not as a verdict', async () => {
    // At runtime a failed reviewer becomes `uncertain`, which is
    // indistinguishable from the gate working. The drill exists to separate
    // those, so it must not inherit that folding.
    behavior = { kind: 'throw' }
    const ctx = await boot(ENABLED)
    const text = await runGate(ctx, 'drill')
    expect(text).toContain('UNREACHABLE')
    expect(text).not.toContain('ruled')
  }, 30_000)
})

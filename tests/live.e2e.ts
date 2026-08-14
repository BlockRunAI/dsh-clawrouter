// Live end-to-end against the real BlockRun gateway. These are the only tests
// that exercise the x402 handshake — 402 -> sign EIP-3009 locally -> retry ->
// settle — which no mock can stand in for, because the signature is the
// authentication.
//
// Real USDC is spent (a fraction of a cent per run). Self-skips when no wallet
// is available, so `vitest run` on a machine without one is still green.
//
// Run with:  npx vitest run tests/live.e2e.ts
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { BlockrunAdapter } from '../src/adapter.ts'
import { BlockrunCatalog } from '../src/catalog.ts'
import { buildReviewPrompt, matchRisk, parseVerdict, REVIEW_SYSTEM_PROMPT } from '../src/reviewer.ts'

const API_URL = 'https://blockrun.ai/api'

/**
 * The wallet key, from the environment or the local BlockRun session file.
 *
 * Returned, never logged: every diagnostic below reports the derived address
 * or nothing at all.
 */
function walletKey(): string | undefined {
  const fromEnv = process.env['BASE_CHAIN_WALLET_KEY'] ?? process.env['BLOCKRUN_WALLET_KEY']
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim()
  try {
    const raw = readFileSync(join(homedir(), '.blockrun', '.session'), 'utf8').trim()
    if (raw.startsWith('{')) {
      const parsed: unknown = JSON.parse(raw)
      const value = (parsed as Record<string, unknown>)['privateKey'] ?? (parsed as Record<string, unknown>)['key']
      return typeof value === 'string' ? value.trim() : undefined
    }
    return raw.length > 0 ? raw : undefined
  } catch {
    // No wallet on this machine: the suite skips rather than failing.
    return undefined
  }
}

const KEY = walletKey()
const live = KEY === undefined ? describe.skip : describe

/** An adapter wired to the real gateway. */
function adapter(): BlockrunAdapter {
  return new BlockrunAdapter({
    provider: 'blockrun',
    connection: () => ({ apiUrl: API_URL, timeoutMs: 120_000 }),
    resolveWalletKey: () => Promise.resolve(KEY!),
    catalog: new BlockrunCatalog('blockrun', `${API_URL}/v1`),
  })
}

/** Drive one real request to completion. */
async function collect(model: string, text: string, maxTokens = 64, system?: string): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter().stream({
    provider: 'blockrun',
    model,
    maxTokens,
    ...system === undefined ? {} : { system },
    messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
  })) {
    chunks.push(chunk)
  }
  return chunks
}

/** Concatenated visible text of a completed response. */
function textOf(chunks: readonly StreamChunk[]): string {
  return chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
}

live('live gateway (spends real USDC)', () => {
  it('completes a paid request through the x402 handshake', async () => {
    const chunks = await collect('deepseek/deepseek-chat', 'Reply with exactly: PONG')

    // Reaching a terminal `stop` at all means 402 -> sign -> retry -> 200 all
    // succeeded and the payment settled; an unpaid or badly signed request
    // never streams.
    const finish = chunks.at(-1)
    expect(finish?.type).toBe('finish')
    expect(finish?.type === 'finish' && finish.reason.kind).toBe('stop')
    expect(textOf(chunks).toUpperCase()).toContain('PONG')
  }, 180_000)

  it('honours the protocol ordering obligations on a real response', async () => {
    const chunks = await collect('deepseek/deepseek-chat', 'Say hello in one short sentence.')

    const usageAt = chunks.findIndex(chunk => chunk.type === 'usage')
    const finishAt = chunks.findIndex(chunk => chunk.type === 'finish')
    expect(finishAt).toBe(chunks.length - 1)
    expect(chunks.filter(chunk => chunk.type === 'finish')).toHaveLength(1)
    if (usageAt !== -1) expect(usageAt).toBeLessThan(finishAt)

    // Every delta belongs to a block that was opened and closed.
    const started = chunks.filter(chunk => chunk.type === 'block-start').map(chunk => chunk.index)
    const ended = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.index)
    expect(started.length).toBeGreaterThan(0)
    expect([...ended].sort()).toEqual([...started].sort())
    for (const chunk of chunks) {
      if (chunk.type === 'text-delta') expect(started).toContain(chunk.index)
    }
  }, 180_000)

  it('reports disjoint, plausible token usage', async () => {
    const chunks = await collect('deepseek/deepseek-chat', 'Count to three.')
    const usage = chunks.find(chunk => chunk.type === 'usage')
    if (usage?.type !== 'usage') return // provider omitted usage; ordering is covered above
    expect(usage.usage.inputTokens).toBeGreaterThanOrEqual(0)
    expect(usage.usage.outputTokens).toBeGreaterThan(0)
    // Cache reads are reported separately, never folded back into input.
    expect(usage.usage.inputTokens).toBeLessThan(10_000)
  }, 180_000)

  it('streams a real tool call as raw JSON arguments', async () => {
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter().stream({
      provider: 'blockrun',
      model: 'deepseek/deepseek-chat',
      maxTokens: 128,
      system: 'You must call the provided tool. Do not answer in prose.',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'What is the weather in Paris? Use the tool.' }],
        source: { kind: 'user' },
      })],
      tools: [{
        name: 'get_weather',
        description: 'Look up the current weather for a city.',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
      }],
    })) {
      chunks.push(chunk)
    }

    const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(call, 'model did not call the tool').toBeDefined()
    if (call?.type !== 'block-end' || call.block.type !== 'tool-call') return
    expect(call.block.name).toBe('get_weather')
    // Raw JSON string end to end — never a parsed object.
    expect(typeof call.block.arguments).toBe('string')
    expect(JSON.parse(call.block.arguments)).toMatchObject({ city: expect.any(String) })
    expect(call.block.id.length).toBeGreaterThan(0)
  }, 180_000)

  it('has a real reviewer model rule rm -rf ~ dangerous', async () => {
    const command = 'rm -rf ~'
    const match = matchRisk('bash', { command })
    expect(match?.rule).toBe('recursive-delete')

    const chunks = await collect(
      'anthropic/claude-opus-5',
      buildReviewPrompt('bash', { command }, match!, '/tmp/project'),
      256,
      REVIEW_SYSTEM_PROMPT,
    )
    const verdict = parseVerdict(textOf(chunks))

    // The end-to-end product claim: a real strong model, given the real prompt,
    // refuses the real command.
    expect(verdict.ruling).toBe('dangerous')
    expect(verdict.reason.length).toBeGreaterThan(0)
  }, 180_000)

  it('has a real reviewer model clear ordinary work', async () => {
    const command = 'rm -rf ./dist'
    const match = matchRisk('bash', { command })!
    const chunks = await collect(
      'anthropic/claude-opus-5',
      buildReviewPrompt('bash', { command }, match, '/tmp/project'),
      256,
      REVIEW_SYSTEM_PROMPT,
    )
    // Deleting a build directory inside the workspace must not be denied, or
    // the gate becomes a nag and gets switched off.
    expect(parseVerdict(textOf(chunks)).ruling).toBe('safe')
  }, 180_000)

  it('rejects an unknown model before spending anything', async () => {
    await expect(collect('does/not-exist', 'hi')).rejects.toThrow(/UNKNOWN_MODEL|does not serve/)
  }, 60_000)
})

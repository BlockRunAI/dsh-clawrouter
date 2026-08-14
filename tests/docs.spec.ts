// Documentation drift, caught mechanically. Adding a config key without
// documenting it is the easy mistake, and the README is the only place a user
// learns the key exists — so the schemas are the source of truth and both
// translations must keep up with them.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as Index from '../src/index.ts'
import * as Review from '../src/review.ts'

const EN = readFileSync('README.md', 'utf8')
const ZH = readFileSync('docs/README.zh.md', 'utf8')

/** The config keys a schemastery object schema declares. */
function keysOf(schema: unknown): string[] {
  return Object.keys((schema as { dict?: Record<string, unknown> }).dict ?? {})
}

describe('README documents the real configuration', () => {
  it.each([
    ['blockrun-llm', Index.Config],
    ['blockrun-review', Review.Config],
  ])('%s: every schema key appears in both READMEs', (_label, schema) => {
    const keys = keysOf(schema)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(EN, `English README does not mention \`${key}\``).toContain(`\`${key}\``)
      expect(ZH, `Chinese README does not mention \`${key}\``).toContain(`\`${key}\``)
    }
  })

  it('states the real default reviewer model', () => {
    for (const doc of [EN, ZH]) expect(doc).toContain(Review.DEFAULT_REVIEWER_MODEL)
  })

  it('keeps the two translations structurally in step', () => {
    // Not a word count — just the headings, so a section added to one language
    // and forgotten in the other shows up here rather than in a user's face.
    const headings = (doc: string): number => doc.split('\n').filter(line => line.startsWith('## ')).length
    expect(headings(ZH)).toBe(headings(EN))
  })

  it('advertises the review gate as off by default, because it is', () => {
    // The gate intercepts tool execution; a README that implied it was on by
    // default would be describing someone else's plugin.
    expect(Review.Config({}).enabled).toBe(false)
    for (const doc of [EN, ZH]) expect(doc).toMatch(/`false`/)
  })
})

describe('the pricing claims agree with the pricing table', () => {
  // Three separate releases shipped a dollar figure in prose that contradicted
  // the measured table a few sections above it. Each was written before the
  // table existed, corrected in one place, and left standing in the other; the
  // surviving copy is the one a reader happens to hit. Prose is now checked
  // against the table mechanically, because reading for it did not work.

  /** Per-model USD quotes from the "small / ~22K in / ~112K in" table. */
  function pricingTable(doc: string): Map<string, number[]> {
    const rows = new Map<string, number[]>()
    for (const line of doc.split('\n')) {
      const cells = line.split('|').map(cell => cell.trim())
      if (cells.length !== 6) continue
      const model = cells[1]?.match(/^`([^`]+)`$/)?.[1]
      const usd = cells.slice(2, 5).map(cell => Number(cell.match(/\$([\d.]+)/)?.[1]))
      if (model && usd.every(value => Number.isFinite(value))) rows.set(model, usd as number[])
    }
    return rows
  }

  it.each([['English', EN], ['Chinese', ZH]])('%s: the table parses and covers both compaction models', (_l, doc) => {
    const table = pricingTable(doc)
    expect(table.get('deepseek/deepseek-chat')).toBeDefined()
    expect(table.get('anthropic/claude-opus-5')).toBeDefined()
  })

  /**
   * The USD figure inside the bold span naming `label` in the compaction
   * section. Matching the span rather than the surrounding sentence is what
   * makes this language-neutral: English writes "$0.90 on Claude Opus 5" and
   * Chinese writes "Claude Opus 5 上大约 $0.90", so a directional regex reads
   * one of them backwards and silently compares the wrong model's price.
   */
  function compactionClaim(doc: string, label: string): number | undefined {
    const section = doc.slice(doc.indexOf('compaction'))
    for (const [, span] of section.matchAll(/\*\*([^*]+)\*\*/g)) {
      if (!span!.includes(label)) continue
      const usd = Number(span!.match(/\$([\d.]+)/)?.[1])
      if (Number.isFinite(usd)) return usd
    }
    return undefined
  }

  it.each([
    ['deepseek/deepseek-chat', 'DeepSeek V4 Flash'],
    ['anthropic/claude-opus-5', 'Claude Opus 5'],
  ])('%s: the ~100K compaction figure sits between its ~22K and ~112K quotes', (model, label) => {
    for (const [lang, doc] of [['English', EN], ['Chinese', ZH]] as const) {
      const claimed = compactionClaim(doc, label)
      expect(claimed, `${lang}: no compaction figure found for ${label}`).toBeDefined()
      const at112k = pricingTable(doc).get(model)![2]!
      // Above the flat floor the quote is linear in input size: measured at
      // both sizes, 100K/112K came to 0.89 for Opus and 0.90 for DeepSeek,
      // against an input ratio of 0.893. So the 100K figure must land just
      // under its 112K neighbour.
      //
      // "Between the 22K and 112K quotes" was the first version of this check
      // and it was useless — it admitted the very $0.50 that prompted writing
      // it. A bound has to be tight enough to reject the bug it was written
      // for, and the only way to know is to feed it that bug.
      const ratio = claimed! / at112k
      expect(ratio, `${lang}: ${model} compaction $${claimed} is ${(ratio * 100).toFixed(0)}% of its ~112K quote $${at112k}; expected 70-100%`)
        .toBeGreaterThan(0.7)
      expect(ratio, `${lang}: ${model} compaction $${claimed} exceeds its ~112K quote $${at112k}`)
        .toBeLessThanOrEqual(1)
    }
  })

  it.each([['English', EN], ['Chinese', ZH]])('%s: no prose revives the per-token pricing model', (_label, doc) => {
    // The claim this project shipped for eleven releases after disproving it.
    for (const stale of ['provider cost plus', '厂商原价', 'flat $0.001/request', '每次请求 $0.001']) {
      expect(doc, `still claims "${stale}"`).not.toContain(stale)
    }
  })
})

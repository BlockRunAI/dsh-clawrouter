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

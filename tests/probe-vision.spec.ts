// The vision probe decides what goes into `VERIFIED_VISION_MODELS`, and that
// list decides whether the harness will let an image be sent at all. So the
// probe is a measuring instrument whose output is pasted into source, and it
// has been wrong twice in one afternoon: once because its output cap starved
// reasoning models of any content, and once because it counted a correct
// answer from a model that was not the one under test.
//
// Neither bug was visible in its output — both looked exactly like the failure
// it was written to detect. That is the argument for testing the judgement
// separately from the request: a probe whose failure mode is indistinguishable
// from a real result cannot be checked by reading its results.
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  COLOURS,
  judgeAnswer,
  MAX_TOKENS,
  png,
  quoteUsd,
  selectCandidates,
  summarize,
  taggedEntries,
} from '../scripts/probe-vision.mjs'

/** A result row in the shape `summarize` consumes. */
function result(ok: boolean, served: string[] = []): { ok: boolean; note: string; served: string[] } {
  return { ok, note: '', served }
}

describe('the image the probe actually sends', () => {
  // If this encoder were wrong, every model would honestly report that it
  // could not read the image and the probe would quietly shrink the verified
  // list to nothing — while looking exactly like a gateway-wide vision
  // outage. It is hand-rolled from zlib and a CRC, so it is worth decoding.
  const decode = (base64: string): Buffer => Buffer.from(base64, 'base64')

  it('is a PNG, by signature', () => {
    expect(decode(png([0, 102, 255])).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  it('declares the dimensions it claims', () => {
    // IHDR payload starts at byte 16: width, height, bit depth, colour type.
    const bytes = decode(png([0, 102, 255], 64))
    expect(bytes.readUInt32BE(16)).toBe(64)
    expect(bytes.readUInt32BE(20)).toBe(64)
    expect(bytes[24]).toBe(8)  // 8 bits per channel
    expect(bytes[25]).toBe(2)  // truecolour, no palette
  })

  it('actually contains the colour asked for, every pixel', () => {
    // The whole test rests on the image being the stated colour: a probe that
    // sent grey and asked "what colour is this" would fail every model for a
    // reason no output would ever reveal.
    const size = 8
    const bytes = decode(png([255, 136, 0], size))
    const start = bytes.indexOf(Buffer.from('IDAT', 'ascii')) + 4
    const length = bytes.readUInt32BE(start - 8)
    const raw = inflateSync(bytes.subarray(start, start + length))
    // Each scanline is a 1-byte filter marker followed by RGB triples.
    for (let row = 0; row < size; row++) {
      const offset = row * (size * 3 + 1)
      expect(raw[offset], 'scanline filter must be None').toBe(0)
      for (let pixel = 0; pixel < size; pixel++) {
        const at = offset + 1 + pixel * 3
        expect([raw[at], raw[at + 1], raw[at + 2]]).toEqual([255, 136, 0])
      }
    }
  })

  it('sends a different image for each colour', () => {
    const rendered = COLOURS.map(colour => png(colour.rgb))
    expect(new Set(rendered).size).toBe(COLOURS.length)
  })
})

describe('the colours are distinguishable, which is the point of using three', () => {
  it('accepts only its own colour name', () => {
    // A blind guess passing all three is what the single-colour version
    // allowed; each pattern must reject the other two for that to hold.
    for (const colour of COLOURS) {
      for (const other of COLOURS) {
        expect(colour.accept.test(other.name), `${colour.name} accepted "${other.name}"`)
          .toBe(colour === other)
      }
    }
  })

  it('reads a one-word answer in a sentence, and is not fooled by a substring', () => {
    const blue = COLOURS.find(colour => colour.name === 'blue')!
    expect(judgeAnswer('The image is blue.', blue).ok).toBe(true)
    expect(judgeAnswer('Blue', blue).ok).toBe(true)
    // Word-bounded: "blueprint" is not an answer of "blue".
    expect(judgeAnswer('It looks like a blueprint', blue).ok).toBe(false)
  })
})

describe('a substituted model is never a pass', () => {
  // The bug this encodes: nemotron-3-nano-omni answered the colour question
  // correctly on a run where the gateway happened to reach it, and was
  // answered by a model with no vision on the runs either side. Counting the
  // good run would have put it in the list on the strength of a measurement
  // of nemotron-3-nano-30b.
  const green = COLOURS.find(colour => colour.name === 'green')!

  it('refuses a right answer that came from another model', () => {
    expect(judgeAnswer('green', green, ['nvidia/nemotron-3-nano-30b']).ok).toBe(false)
  })

  it('still accepts a right answer when nothing was substituted', () => {
    expect(judgeAnswer('green', green, []).ok).toBe(true)
  })

  it('keeps the answer text either way, so the reason stays readable', () => {
    expect(judgeAnswer('green', green, ['x']).note).toBe('green')
  })

  it('names an empty answer rather than showing nothing', () => {
    // An empty answer meant "the output cap starved a reasoning model", which
    // is why it must be legible rather than blank.
    expect(judgeAnswer('', green).note).toBe('(empty answer)')
  })

  it('counts substitutions per model rather than collapsing them', () => {
    // "answered as X" cannot distinguish a cascade twitch from a model that is
    // never reachable; the count is the whole signal.
    const { substitutes } = summarize([
      result(false, ['a']),
      result(false, ['a']),
      result(false, ['b']),
    ], 3)
    expect(Object.fromEntries(substitutes)).toEqual({ a: 2, b: 1 })
  })
})

describe('the pass rule', () => {
  it('requires every colour, not a majority', () => {
    expect(summarize([result(true), result(true), result(false)], 3).pass).toBe(false)
    expect(summarize([result(true), result(true), result(true)], 3).pass).toBe(true)
  })

  it('refuses a short run rather than passing it', () => {
    // Three wins out of three attempts is not a pass if only two colours were
    // ever asked — an aborted sweep must not promote a model.
    expect(summarize([result(true), result(true)], 3).pass).toBe(false)
  })

  it('reports the win count even when it fails', () => {
    expect(summarize([result(true), result(false), result(false)], 3).wins).toBe(1)
  })
})

describe('choosing what to measure', () => {
  const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('defaults to the tagged models the list does not already admit', () => {
    expect(selectCandidates(entries, { verified: new Set(['a']) }).map(model => model.id))
      .toEqual(['b', 'c'])
  })

  it('re-measures everything with --all', () => {
    expect(selectCandidates(entries, { all: true, verified: new Set(['a']) }).map(model => model.id))
      .toEqual(['a', 'b', 'c'])
  })

  it('lets --models win over --all, so a re-check stays cheap', () => {
    const named = new Set(['b'])
    expect(selectCandidates(entries, { all: true, named, verified: new Set() }).map(model => model.id))
      .toEqual(['b'])
  })

  it('keeps only chat+vision entries out of a raw catalog body', () => {
    const ids = taggedEntries({
      data: [
        { id: 'sees', categories: ['chat', 'vision'] },
        { id: 'text-only', categories: ['chat'] },
        { id: 'image-gen', categories: ['image', 'vision'] },
        { id: 'untagged' },
        { categories: ['chat', 'vision'] },
      ],
    }).map((model: { id: string }) => model.id)
    expect(ids).toEqual(['sees'])
  })
})

describe('the cost estimate', () => {
  // It used to assume the $0.002 floor for every call. That stopped being true
  // the moment the output cap became real: the gateway quotes on requested
  // max_tokens, so the floor understated a pro model by more than 20x, in the
  // line a reader uses to decide whether to run the sweep.
  it('is zero for a free model', () => {
    expect(quoteUsd({ id: 'x', billing_mode: 'free', pricing: { output: 0 } })).toBe(0)
  })

  it('never quotes below the floor', () => {
    expect(quoteUsd({ id: 'x', billing_mode: 'paid', pricing: { output: 0.13 } })).toBe(0.002)
  })

  it('follows the output rate once the cap costs more than the floor', () => {
    // $180/M at a 256-token cap is the case the floor hid.
    const quoted = quoteUsd({ id: 'x', billing_mode: 'paid', pricing: { output: 180 } })
    expect(quoted).toBeCloseTo(0.001 + (MAX_TOKENS / 1_000_000) * 180, 6)
    expect(quoted).toBeGreaterThan(0.04)
  })

  it('does not crash on a model the catalog does not price', () => {
    expect(quoteUsd({ id: 'x', billing_mode: 'paid' })).toBe(0.002)
  })
})

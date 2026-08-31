// Measures which `vision`-tagged models actually accept an image through the
// gateway, and prints the `VERIFIED_VISION_MODELS` array to paste back.
//
// This list cannot be maintained by reading the catalog: the `vision` tag
// over-claims, and every way it is wrong costs the caller something. Some
// models drop the image and answer as if none was sent; one returns HTTP 500
// after taking payment. Declaring image input from the tag admits an
// attachment that fails mid-turn, after the message is durable and paid for.
//
// So the list is measured, and it was measured by hand three times before this
// script existed — on 2026-08-16, 2026-08-30, and 2026-08-31, each time
// because the roster had moved underneath it. That is the argument for a
// script rather than a fourth set of ad-hoc curl commands.
//
// Usage:
//   npm run probe:vision            # only tagged models not yet in the list
//   npm run probe:vision -- --all   # re-measure every tagged model
//
// Spends real USDC on paid models — roughly $0.002 per call, three calls per
// model. Free models cost nothing. The estimate is printed before anything is
// sent.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { BlockrunAdapter } from '../src/adapter.ts'
import { BlockrunCatalog, VERIFIED_VISION_MODELS } from '../src/catalog.ts'
import { DEFAULT_API_URL } from '../src/index.ts'

const API_URL = DEFAULT_API_URL

/**
 * Three colours rather than one, because a single solid colour is guessable.
 * "What colour is this image" answered "blue" by a model that received nothing
 * is right one time in six or so, and the 2026-08-30 run used one colour — so
 * a model that answers a plausible colour without looking could have passed.
 * All three must be right, which drops a blind guess to well under a percent.
 */
const COLOURS = [
  { name: 'blue', rgb: [0, 102, 255], accept: /\bblue\b/i },
  { name: 'green', rgb: [0, 168, 66], accept: /\bgreen\b/i },
  { name: 'orange', rgb: [255, 136, 0], accept: /\borange\b/i },
]

const PROMPT = 'What colour is this image? Answer with one word.'

/** A solid-colour PNG, base64, built here so the probe carries no fixtures. */
function png([r, g, b], size = 64) {
  const row = Buffer.concat([Buffer.of(0), Buffer.alloc(size * 3).fill(Buffer.of(r, g, b))])
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const check = Buffer.alloc(4)
    check.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, check])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8) // 8-bit, truecolour, no interlace
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}

/** The wallet key, from the environment or the local session file. Never logged. */
function walletKey() {
  const fromEnv = process.env['BASE_CHAIN_WALLET_KEY'] ?? process.env['BLOCKRUN_WALLET_KEY']
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim()
  try {
    const raw = readFileSync(join(homedir(), '.blockrun', '.session'), 'utf8').trim()
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw)
      const value = parsed['privateKey'] ?? parsed['key']
      return typeof value === 'string' ? value.trim() : undefined
    }
    return raw.length > 0 ? raw : undefined
  } catch {
    return undefined
  }
}

const response = await fetch(`${API_URL}/v1/models`)
if (!response.ok) throw new Error(`catalog request failed: ${response.status}`)
const body = await response.json()
const entries = (body.data ?? []).filter(model =>
  typeof model?.id === 'string'
  && model.categories?.includes('chat') === true
  && model.categories?.includes('vision') === true)

const all = process.argv.includes('--all')
const verified = new Set(VERIFIED_VISION_MODELS)
const candidates = all ? entries : entries.filter(model => !verified.has(model.id))

if (candidates.length === 0) {
  console.log(`Every one of the ${entries.length} vision-tagged models is already measured. Pass --all to re-measure.`)
  process.exit(0)
}

const paid = candidates.filter(model => model.billing_mode !== 'free').length
console.log(`${entries.length} vision-tagged models, ${candidates.length} to measure (${paid} paid).`)
console.log(`~$${(paid * COLOURS.length * 0.002).toFixed(3)} at the $0.002 floor. Free models cost nothing.\n`)

// A key is needed only for the paid ones; the adapter asks for it per model,
// so a run over free candidates alone works on a machine with no wallet.
const key = walletKey()
if (key === undefined && paid > 0) {
  console.log('No wallet key found (BASE_CHAIN_WALLET_KEY or ~/.blockrun/.session); paid models will fail.\n')
}

/** One adapter per model, so `visionModels` can admit the candidate under test. */
function adapterFor(model, base64) {
  return new BlockrunAdapter({
    provider: 'blockrun',
    connection: () => ({ apiUrl: API_URL, timeoutMs: 120_000 }),
    resolveWalletKey: () => key === undefined
      ? Promise.reject(new Error('no wallet key configured'))
      : Promise.resolve(key),
    // Widened deliberately: the point is to measure a model the default list
    // does not yet admit, and the default would refuse the image locally.
    catalog: new BlockrunCatalog('blockrun', `${API_URL}/v1`, Date.now, [model]),
    resolveImage: () => Promise.resolve(`data:image/png;base64,${base64}`),
  })
}

/** Ask one model about one colour. */
async function ask(model, colour) {
  const text = []
  try {
    for await (const chunk of adapterFor(model, png(colour.rgb)).stream({
      provider: 'blockrun',
      model,
      maxTokens: 24,
      messages: [createUserMessage({
        content: [
          { type: 'text', text: PROMPT },
          {
            type: 'image',
            attachment: {
              attachmentId: randomBytes(8).toString('hex'),
              mediaType: 'image/png',
              bytes: 0,
              width: 64,
              height: 64,
            },
          },
        ],
        source: { kind: 'user' },
      })],
    })) {
      if (chunk.type === 'text-delta') text.push(chunk.text)
      if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
        return { ok: false, note: chunk.reason.failure.code }
      }
    }
  } catch (error) {
    return { ok: false, note: error?.code ?? String(error?.message ?? error).slice(0, 60) }
  }
  const answer = text.join('').trim()
  return {
    ok: colour.accept.test(answer),
    note: answer.length === 0 ? '(empty answer)' : answer.slice(0, 48).replace(/\s+/g, ' '),
  }
}

const passed = []
for (const model of candidates) {
  const results = []
  for (const colour of COLOURS) results.push({ colour, ...await ask(model.id, colour) })
  const wins = results.filter(result => result.ok).length
  const verdict = wins === COLOURS.length ? 'PASS' : 'FAIL'
  if (verdict === 'PASS') passed.push(model.id)
  const tier = model.billing_mode === 'free' ? ' [free]' : ''
  console.log(`${verdict}  ${model.id}${tier}  ${wins}/${COLOURS.length}`)
  for (const result of results) {
    if (!result.ok) console.log(`        ${result.colour.name} -> ${result.note}`)
  }
}

// Printed as source rather than as a list, because the last three refreshes
// each ended with someone retyping thirty ids by hand.
const merged = [...new Set(all ? passed : [...verified, ...passed])].sort()
console.log(`\n${passed.length} of ${candidates.length} passed. VERIFIED_VISION_MODELS becomes ${merged.length}:\n`)
for (const id of merged) console.log(`  '${id}',`)

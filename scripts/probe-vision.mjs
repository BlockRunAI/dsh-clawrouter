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
// Spends real money on paid models. On a wallet that is roughly $0.002 per
// call, three calls per
// model. Free models cost nothing. The estimate is printed before anything is
// sent.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { BlockrunAdapter } from '../src/adapter.ts'
import { BlockrunCatalog, VERIFIED_VISION_MODELS } from '../src/catalog.ts'
import { catalogEndpoint, DEFAULT_API_KEY_URL, DEFAULT_SOLANA_API_URL } from '../src/auth.ts'
import { DEFAULT_API_URL } from '../src/index.ts'
import { SpendMeter } from '../src/spend.ts'

/**
 * The credential this run uses, and the host it is valid against.
 *
 * The order matches the plugin's: account key, then Solana, then Base. An
 * account key is preferred for one reason specific to a probe as well — it is
 * billed at exact usage, so measuring forty models costs a fraction of what
 * forty flat x402 quotes do. The hosts are not interchangeable: a `brk_live_…`
 * key on a wallet gateway is answered 402, the account host answers an
 * unauthenticated catalog read 401, and neither chain can verify the other's
 * signature — so the host travels with the credential.
 * @returns {import('../src/auth.ts').BlockrunAuth | undefined} the resolved
 *   auth, or undefined when no credential is available at all.
 */
function resolveProbeAuth() {
  const account = process.env['BLOCKRUN_API_KEY']?.trim()
  if (account !== undefined && account.length > 0) {
    return /** @type {const} */ ({ mode: 'api-key', apiKey: account, apiUrl: DEFAULT_API_KEY_URL })
  }
  const solana = process.env['SOLANA_WALLET_KEY']?.trim()
  if (solana !== undefined && solana.length > 0) {
    return /** @type {const} */ ({ mode: 'solana-wallet', privateKey: solana, apiUrl: DEFAULT_SOLANA_API_URL })
  }
  const wallet = walletKey()
  if (wallet === undefined) return undefined
  return /** @type {const} */ ({ mode: 'wallet', privateKey: wallet, apiUrl: DEFAULT_API_URL })
}

const AUTH = resolveProbeAuth()
const API_URL = AUTH?.apiUrl ?? DEFAULT_API_URL
/** Headers the catalog read needs; the account host refuses an anonymous one. */
const CATALOG_HEADERS = AUTH === undefined ? {} : (catalogEndpoint(AUTH).headers ?? {})

/**
 * One `GET /v1/models` entry, in the shape this script reads.
 * @typedef {{ id: string, categories?: string[], billing_mode?: string, pricing?: { output?: number } }} CatalogEntry
 */

/**
 * One colour under test.
 * @typedef {{ name: string, rgb: number[], accept: RegExp }} Colour
 */

/**
 * One answer, judged.
 * @typedef {{ ok: boolean, note: string, served: string[] }} Judged
 */

/**
 * Three colours rather than one, because a single solid colour is guessable.
 * "What colour is this image" answered "blue" by a model that received nothing
 * is right one time in six or so, and the 2026-08-30 run used one colour — so
 * a model that answers a plausible colour without looking could have passed.
 * All three must be right, which drops a blind guess to well under a percent.
 */
export const COLOURS = [
  { name: 'blue', rgb: [0, 102, 255], accept: /\bblue\b/i },
  { name: 'green', rgb: [0, 168, 66], accept: /\bgreen\b/i },
  { name: 'orange', rgb: [255, 136, 0], accept: /\borange\b/i },
]

const PROMPT = 'What colour is this image? Answer with one word.'

/**
 * Output cap per probe call.
 *
 * Not 24, which is all a one-word answer needs and which produced a false
 * result on 2026-08-31: `deepseek/deepseek-v4-flash-vision-exp`,
 * `qwen/qwen3.8-flash` and `xiaomi/mimo-v2.5` all returned an EMPTY answer
 * three times each and were read as vision failures. All three are tagged
 * `reasoning`, and a reasoning model spends its budget thinking before it
 * emits a single character of content — so the cap, not the model, was what
 * produced nothing. A probe whose failure mode is indistinguishable from the
 * failure it is looking for is worse than no probe.
 *
 * The gateway settles on requested max_tokens, so this is not free: on a
 * `$180/M` output model it is about $0.046 a call rather than the floor. The
 * estimate printed below is computed from real catalog prices for that reason.
 */
export const MAX_TOKENS = 256

/** A solid-colour PNG, base64, built here so the probe carries no fixtures. */
/**
 * @param {number[]} rgb - the colour, as three 0-255 channels.
 * @param {number} [size] - square edge in pixels.
 * @returns {string} base64 PNG.
 */
export function png([r, g, b], size = 64) {
  const row = Buffer.concat([Buffer.of(0), Buffer.alloc(size * 3).fill(Buffer.of(r ?? 0, g ?? 0, b ?? 0))])
  /** @type {(type: string, data: Buffer) => Buffer} */
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

/**
 * Whether one answer counts, and what to show for it.
 *
 * A right answer from a SUBSTITUTED model is not a pass. The gateway answers
 * some requests with a different model, and a substitute that cannot see
 * images answers a vision question exactly as the real model would if it were
 * broken — so counting it would put an entry in the list on the strength of a
 * measurement of something else. Separated from the request so the rule can be
 * tested without a gateway: it decides what goes into source, and it has been
 * wrong twice.
 *
 * @param answer - the model's text, already trimmed.
 * @param colour - the colour under test, carrying its accept pattern.
 * @param served - ids that answered instead, empty when the right model did.
 */
/**
 * @param {string} answer
 * @param {Colour} colour
 * @param {string[]} [served]
 * @returns {Judged}
 */
export function judgeAnswer(answer, colour, served = []) {
  return {
    ok: colour.accept.test(answer) && served.length === 0,
    note: answer.length === 0 ? '(empty answer)' : answer.slice(0, 48).replace(/\s+/g, ' '),
    served,
  }
}

/**
 * One model's verdict across every colour.
 *
 * Substitutions are counted per served id rather than collected into a set:
 * "answered as X" leaves the reader unable to tell a cascade twitch from a
 * model that is never reachable, and those mean different things.
 */
/**
 * @param {Judged[]} results
 * @param {number} [colourCount]
 */
export function summarize(results, colourCount = COLOURS.length) {
  const substitutes = new Map()
  for (const result of results) {
    for (const id of result.served ?? []) substitutes.set(id, (substitutes.get(id) ?? 0) + 1)
  }
  const wins = results.filter(result => result.ok).length
  return { wins, pass: wins === colourCount && results.length === colourCount, substitutes }
}

/**
 * The models this run should measure.
 *
 * `--models=a,b` wins over `--all`, which wins over the default of "everything
 * tagged that the list does not already admit".
 */
/**
 * @param {CatalogEntry[]} entries
 * @param {{ all?: boolean, named?: Set<string>, verified?: Set<string> }} [options]
 * @returns {CatalogEntry[]}
 */
export function selectCandidates(entries, options = {}) {
  const { all = false, named, verified = new Set() } = options
  if (named !== undefined) return entries.filter(model => named.has(model.id))
  return all ? entries : entries.filter(model => !verified.has(model.id))
}

/**
 * What one call to `model` is quoted at, at {@link MAX_TOKENS}.
 *
 * Priced from the catalog rather than from the $0.002 floor, because the floor
 * stops being the answer as soon as the output cap is real: this gateway
 * quotes on the max_tokens requested, so one call to a $180/M model is about
 * $0.046 — a 23x difference the floor-based estimate hid.
 */
/**
 * @param {CatalogEntry} model
 * @param {number} [maxTokens]
 */
export function quoteUsd(model, maxTokens = MAX_TOKENS) {
  if (model.billing_mode === 'free') return 0
  const output = typeof model.pricing?.output === 'number' ? model.pricing.output : 0
  return Math.max(0.002, 0.001 + (maxTokens / 1_000_000) * output)
}

/** Chat+vision entries from a raw `GET /v1/models` body. */
/**
 * @param {unknown} body - decoded `GET /v1/models` response.
 * @returns {CatalogEntry[]}
 */
export function taggedEntries(body) {
  const data = /** @type {{ data?: CatalogEntry[] }} */ (body)?.data
  return (data ?? []).filter(model =>
    typeof model?.id === 'string'
    && model.categories?.includes('chat') === true
    && model.categories?.includes('vision') === true)
}

/** Everything that touches the network or the console. */
async function main() {
  const response = await fetch(`${API_URL}/v1/models`, { headers: { accept: 'application/json', ...CATALOG_HEADERS } })
  if (!response.ok) throw new Error(`catalog request failed: ${response.status}`)
  const body = await response.json()
    const entries = taggedEntries(body)

  const all = process.argv.includes('--all')
  const verified = new Set(VERIFIED_VISION_MODELS)
  // `--models a,b` re-measures a named few. A verdict that turned on timing —
  // the gateway substituting on one run and not the next — is worth re-running
  // on its own rather than paying for the whole sweep again.
  const only = process.argv.find(argument => argument.startsWith('--models='))?.slice('--models='.length)
  const named = only === undefined ? undefined : new Set(only.split(',').map(id => id.trim()).filter(Boolean))
  const candidates = selectCandidates(entries, { all, verified, ...named === undefined ? {} : { named } })

  if (named !== undefined) {
    for (const id of named) {
      if (!entries.some(model => model.id === id)) console.log(`note: ${id} is not a chat+vision entry in the catalog`)
    }
  }

  if (candidates.length === 0) {
    console.log(`Every one of the ${entries.length} vision-tagged models is already measured. Pass --all to re-measure.`)
    process.exit(0)
  }

  const paid = candidates.filter(model => model.billing_mode !== 'free')
  const estimate = paid.reduce((sum, model) => sum + quoteUsd(model) * COLOURS.length, 0)
  console.log(`${entries.length} vision-tagged models, ${candidates.length} to measure (${paid.length} paid).`)
  console.log(`~$${estimate.toFixed(3)} for ${paid.length * COLOURS.length} paid calls at ${MAX_TOKENS} max_tokens. Free models cost nothing.`)
  for (const model of [...paid].sort((left, right) => quoteUsd(right) - quoteUsd(left)).slice(0, 3)) {
    if (quoteUsd(model) > 0.01) console.log(`    ${model.id} is ~$${quoteUsd(model).toFixed(3)} a call`)
  }
  console.log()

  // A credential is needed only for the paid ones on the wallet path; the
  // adapter asks per model, so a run over free candidates alone works on a
  // machine with neither. On the account host even a free model needs the key,
  // because that host answers an unauthenticated request 401 whatever it costs.
  if (AUTH === undefined && paid.length > 0) {
    console.log(
      'No BlockRun credential found (BLOCKRUN_API_KEY, SOLANA_WALLET_KEY,'
      + ' or BASE_CHAIN_WALLET_KEY / ~/.blockrun/.session);'
      + ' paid models will fail.\n',
    )
  } else if (AUTH?.mode === 'api-key') {
    console.log(`Billing to the BlockRun account via ${API_URL} — exact token usage, no per-call fee.\n`)
  } else if (AUTH?.mode === 'solana-wallet') {
    console.log(`Paying from a Solana wallet via ${API_URL}.\n`)
  }

  /** One adapter per model, so `visionModels` can admit the candidate under test. */
  /**
   * @param {string} model
   * @param {string} base64
   * @param {SpendMeter} meter
   */
  function adapterFor(model, base64, meter) {
    return new BlockrunAdapter({
      provider: 'blockrun',
      connection: () => ({ apiUrl: API_URL, timeoutMs: 120_000 }),
      resolveAuth: () => AUTH === undefined
        ? Promise.reject(new Error('no BlockRun credential configured'))
        : Promise.resolve(AUTH),
      // Widened deliberately: the point is to measure a model the default list
      // does not yet admit, and the default would refuse the image locally.
      catalog: new BlockrunCatalog(
        'blockrun',
        `${API_URL}/v1`,
        Date.now,
        [model],
        undefined,
        AUTH === undefined ? undefined : async () => catalogEndpoint(AUTH),
      ),
      resolveImage: () => Promise.resolve(`data:image/png;base64,${base64}`),
      // Carried only to read back which model actually answered. The gateway
      // substitutes silently, and a substitute that cannot see images answers a
      // vision question as though none was asked — which looks exactly like the
      // model failing. Without this, a run that happens to reach the real model
      // reads as a pass and the list gets an entry that works intermittently.
      meter,
    })
  }

  /** Ask one model about one colour. */
  /**
   * @param {string} model
   * @param {Colour} colour
   * @returns {Promise<Judged>}
   */
  async function ask(model, colour) {
    const text = []
    const meter = new SpendMeter(0)
    const servedBy = () => Object.keys(meter.summary().byModel[0]?.servedBy ?? {})
    try {
      for await (const chunk of adapterFor(model, png(colour.rgb), meter).stream({
        provider: 'blockrun',
        model,
        maxTokens: MAX_TOKENS,
        messages: [createUserMessage({
          content: [
            { type: 'text', text: PROMPT },
            {
              type: 'image',
              attachment: {
                attachmentId: AttachmentId(randomBytes(8).toString('hex')),
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
          return { ok: false, note: chunk.reason.failure.code, served: servedBy() }
        }
      }
    } catch (error) {
        const failure = /** @type {{ code?: string, message?: string }} */ (error)
      return { ok: false, note: failure?.code ?? String(failure?.message ?? error).slice(0, 60), served: servedBy() }
    }
    return judgeAnswer(text.join('').trim(), colour, servedBy())
  }

  const passed = []
  for (const model of candidates) {
    const results = []
    for (const colour of COLOURS) results.push({ colour, ...await ask(model.id, colour) })
    const { wins, pass, substitutes } = summarize(results)
    if (pass) passed.push(model.id)
    const tier = model.billing_mode === 'free' ? ' [free]' : ''
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${model.id}${tier}  ${wins}/${COLOURS.length}`)
    for (const result of results) {
      if (!result.ok) console.log(`        ${result.colour.name} -> ${result.note}`)
    }
    for (const [id, count] of substitutes) {
      console.log(`        NOT MEASURED: answered as ${id} on ${count} of ${COLOURS.length} — says nothing about ${model.id}`)
    }
  }

  // Printed as source rather than as a list, because the last three refreshes
  // each ended with someone retyping thirty ids by hand.
  const merged = [...new Set(all ? passed : [...verified, ...passed])].sort()
  console.log(`\n${passed.length} of ${candidates.length} passed. VERIFIED_VISION_MODELS becomes ${merged.length}:\n`)
  for (const id of merged) console.log(`  '${id}',`)

}

// Importable for tests without running a sweep: `process.argv[1]` is the entry
// script when this is executed directly, and something else when it is not.
// `import.meta.main` would be tidier but does not exist on Node 22.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}

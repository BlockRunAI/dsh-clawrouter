/**
 * `dsh-clawrouter`: registers the BlockRun provider route with `ctx.llm`.
 *
 * A function/namespace plugin, NOT a default-export service — this plugin does
 * not own the `ctx.llm` key, it registers INTO the seam's adapter registry the
 * way `@deepseek-ai/dsh-llm-deepseek` does. Mixing the two export forms makes
 * the Loader discard this module's `inject` metadata.
 *
 * Mounting the route does not change any agent's model. `dsh-base` keeps
 * `deepseek-official` as the default; this route is selected explicitly, or
 * used by the review gate in `./review`.
 *
 * @module dsh-clawrouter
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { BlockrunAdapter } from './adapter.ts'
import type { BlockrunConnection } from './adapter.ts'
import {
  API_KEY_PATTERN,
  catalogEndpoint,
  DEFAULT_API_KEY_URL,
  DEFAULT_REQUEST_FEES,
  DEFAULT_SOLANA_API_URL,
  freeTierKey,
  PORTAL_URL,
  requestFeeFor,
  SOLANA_WALLET_KEY_PATTERN,
  WALLET_KEY_PATTERN,
} from './auth.ts'
import type { AuthResolver, BlockrunAuth } from './auth.ts'
import { BlockrunCatalog, DEFAULT_MAX_TOKENS_CEILING, VERIFIED_VISION_MODELS } from './catalog.ts'
import { renderSpend, SpendMeter } from './spend.ts'
// Side-effect type import: `ctx.commands` exists only once the commands
// package has been imported for its declaration merging.
import type {} from '@deepseek-ai/dsh-commands'
// Side-effect type import: `ctx.attachments` exists only once the attachment
// package is composed. Typed here, resolved optionally at request time.
import type {} from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

export { BlockrunAdapter } from './adapter.ts'
export { DEFAULT_API_KEY_URL, DEFAULT_SOLANA_API_URL, PORTAL_URL, requestFeeFor } from './auth.ts'
export type { AuthResolver, BlockrunAuth } from './auth.ts'
export { BlockrunCatalog } from './catalog.ts'
export { StreamTranslator } from './translate.ts'
export { renderSpend, SpendMeter } from './spend.ts'
export type { CallPricing, ModelRates, ModelSpend, SpendBasis, SpendSummary } from './spend.ts'
export type { BlockrunCatalogModel, BlockrunStreamChunk, ReviewVerdict, RiskMatch } from './types.ts'

/** BlockRun's public API root — the x402 gateway a Base wallet pays. */
export const DEFAULT_API_URL = 'https://blockrun.ai/api'

/**
 * Flat per-request x402 fee on the SOLANA wallet path, as the gateway quotes it.
 *
 * Measured 2026-09-05: the same `deepseek/deepseek-chat` request that Base
 * answers `{"amount":"2000"}` is quoted `{"amount":"1000"}` on Solana, both in
 * µUSDC. Carried separately because `/spend` multiplies this by the call count
 * — one figure for both chains is simply wrong on one of them.
 */
export const DEFAULT_SOLANA_REQUEST_FEE_USD = DEFAULT_REQUEST_FEES.solana

/** Harness route key this plugin registers by default. */
export const DEFAULT_PROVIDER = 'blockrun'

/**
 * Flat per-request x402 fee on the WALLET path, as the gateway actually quotes it.
 *
 * It does not describe an API-key deployment at all: `api.blockrun.ai` bills
 * the account at exact token usage with no per-call fee and no minimum, so
 * `/spend` prices those calls from the catalog's rates instead. See
 * {@link ../spend.ts | SpendMeter}.
 *
 * Measured, not read from the price list: the 402 for a ~17-token request
 * quotes `{"amount":"0.002000"}`, and three calls moved the wallet by exactly
 * $0.006. BlockRun's published pricing page says $0.001; this follows the
 * quote, because the quote is what settles.
 */
export const DEFAULT_REQUEST_FEE_USD = 0.002

/** Default per-request SDK timeout; long reasoning responses routinely exceed a minute. */
export const DEFAULT_TIMEOUT_MS = 300_000

/** Cordis plugin name used by loader diagnostics. */
export const name = 'blockrun-llm'

/** The LLM seam this adapter registers into. */
export const inject = ['llm']

/** Plugin configuration. */
export interface Config {
  /**
   * Harness provider route to register. Changing it lets one deployment mount
   * two BlockRun routes (say, Base and Solana) side by side.
   */
  provider?: string
  /**
   * Credential *reference* naming the environment variable or managed entry
   * that holds the BlockRun account key (`brk_live_…`).
   *
   * Checked BEFORE {@link Config.walletKeyEnv}, and it is the recommended way
   * to run this route: an account is billed at exact token usage with no
   * per-call fee, every call lands on the ledger behind
   * `user.blockrun.ai/dashboard`, and there is no private key to look after.
   * Get one by signing in at `user.blockrun.ai` and issuing a key.
   *
   * A deployment holding neither credential still reaches the free models. The
   * value never appears in configuration; this names where it is read from.
   */
  apiKeyEnv?: string
  /**
   * Credential *reference* naming the environment variable or managed entry
   * that holds the SOLANA wallet key, for paying per call over x402.
   *
   * Checked after {@link Config.apiKeyEnv} and BEFORE
   * {@link Config.walletKeyEnv}. A deployment holding both wallets has said
   * which chains it can pay on rather than which it prefers, and this route
   * picks Solana — the chain BlockRun's own SDK recommends, serving a catalog
   * verified identical to Base's, id for id.
   *
   * Paying on Solana needs `@solana/web3.js` and `@solana/spl-token`
   * installed. They are optional peers of `@blockrun/llm` and of this package,
   * so a Base-only deployment does not carry them.
   */
  solanaWalletKeyEnv?: string
  /**
   * Credential *reference* naming the environment variable or managed entry
   * that holds the EVM (Base) wallet key, for paying per call over x402.
   *
   * Used only when neither an account key nor a Solana wallet resolves — the
   * credentials are mutually exclusive, and a deployment that configured
   * several meant the first one this route finds. The value never appears in
   * configuration.
   */
  walletKeyEnv?: string
  /** x402 gateway root a Base wallet pays; point at a private deployment. */
  apiUrl?: string
  /** x402 gateway root a Solana wallet pays. */
  solanaApiUrl?: string
  /**
   * Account API root an API key authenticates against.
   *
   * A separate key from {@link Config.apiUrl} because these are separate
   * hosts, not a preference: `brk_live_…` on the wallet gateway is answered
   * `402`, and a wallet signature on the account host is answered `401`.
   */
  apiKeyUrl?: string
  /**
   * Models this route may send images to.
   *
   * Defaults to the set measured to work through the gateway; a `vision` tag
   * alone is not enough, since several tagged models charge and then fail. See
   * {@link VERIFIED_VISION_MODELS}.
   */
  visionModels?: string[]
  /**
   * Ceiling on the default output cap taken from a model's `max_output`.
   *
   * The gateway quotes on requested `max_tokens` and settles that amount, so a
   * model's full advertised ceiling bills every unspecified call for output
   * nobody asked for. Raise it when a workload genuinely needs longer replies.
   */
  maxOutputCeiling?: number
  /** Per-request SDK timeout in milliseconds. */
  timeoutMs?: number
  /**
   * What one request costs on the BASE wallet path, used by `/spend`.
   * Configurable because it is a published price rather than a protocol
   * constant, and a stale number here is a wrong total.
   */
  requestFeeUsd?: number
  /** The same figure for the SOLANA wallet path, which the gateway quotes lower. */
  solanaRequestFeeUsd?: number
  /**
   * Model serving the harness's own maintenance calls — context compaction and
   * session titles — instead of the conversation's model.
   *
   * Compaction summarizes the WHOLE conversation, so on a flagship model a
   * long session pays flagship input rates for a job a cheap model does well.
   * Those calls share no prefix with the conversation, so moving them forfeits
   * no prompt-cache hit. Omitted leaves them on the conversation model, which
   * is what the harness does by default.
   */
  auxiliaryModel?: string
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  provider: z.string().default(DEFAULT_PROVIDER),
  apiKeyEnv: z.string().role('credential-ref').default('BLOCKRUN_API_KEY'),
  solanaWalletKeyEnv: z.string().role('credential-ref').default('SOLANA_WALLET_KEY'),
  walletKeyEnv: z.string().role('credential-ref').default('BASE_CHAIN_WALLET_KEY'),
  apiUrl: z.string().default(DEFAULT_API_URL),
  solanaApiUrl: z.string().default(DEFAULT_SOLANA_API_URL),
  apiKeyUrl: z.string().default(DEFAULT_API_KEY_URL),
  timeoutMs: z.natural().default(DEFAULT_TIMEOUT_MS),
  requestFeeUsd: z.number().min(0).default(DEFAULT_REQUEST_FEE_USD),
  solanaRequestFeeUsd: z.number().min(0).default(DEFAULT_SOLANA_REQUEST_FEE_USD),
  auxiliaryModel: z.string(),
  visionModels: z.array(z.string()).default([...VERIFIED_VISION_MODELS]),
  maxOutputCeiling: z.natural().default(DEFAULT_MAX_TOKENS_CEILING),
})

/**
 * Register the BlockRun adapter.
 * @param ctx - the plugin's context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const provider = nonEmpty(config.provider, DEFAULT_PROVIDER)
  const apiUrl = nonEmpty(config.apiUrl, DEFAULT_API_URL).replace(/\/$/, '')
  const apiKeyUrl = nonEmpty(config.apiKeyUrl, DEFAULT_API_KEY_URL).replace(/\/$/, '')
  const solanaApiUrl = nonEmpty(config.solanaApiUrl, DEFAULT_SOLANA_API_URL).replace(/\/$/, '')
  const apiKeyRef = credentialRef(nonEmpty(config.apiKeyEnv, 'BLOCKRUN_API_KEY'))
  const solanaRef = credentialRef(nonEmpty(config.solanaWalletKeyEnv, 'SOLANA_WALLET_KEY'))
  const ref = credentialRef(nonEmpty(config.walletKeyEnv, 'BASE_CHAIN_WALLET_KEY'))
  const timeoutMs = config.timeoutMs !== undefined && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS

  const auxiliaryModel = config.auxiliaryModel !== undefined && config.auxiliaryModel.length > 0
    ? config.auxiliaryModel
    : undefined
  const connection = (): BlockrunConnection => ({
    apiUrl,
    timeoutMs,
    ...auxiliaryModel === undefined ? {} : { auxiliaryModel },
  })

  // Resolved per operation, never cached: a key rotated in the managed store
  // must reach the very next request without reloading this plugin.
  //
  // This route deliberately reads no key file of its own. A credential nobody
  // configured, quietly shadowing the one they did, is the confusion the
  // credentials seam exists to prevent.
  const readCredential = async (reference: CredentialRef): Promise<string | undefined> => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(reference)
      return hit === undefined || hit.value.length === 0 ? undefined : hit.value
    }
    // Without the seam there is no managed store to rank against, so the
    // launching environment is the whole credential plane.
    const ambient = launchEnvironmentOf(ctx).get(reference)
    return ambient === undefined || ambient.value.length === 0 ? undefined : ambient.value
  }

  /**
   * The credential one request will use.
   *
   * The order is the whole contract:
   *
   *   1. An account key wins because it is the one someone chose deliberately,
   *      and paying from a wallet they merely happen to have exported would
   *      spend money on a call they meant to put on the account.
   *   2. Then the free tier short-circuits. Free models are free on both
   *      wallet gateways, but `api.blockrun.ai` answers an unauthenticated
   *      request `401` whatever it costs, so a configured key is still sent.
   *   3. Then Solana, ahead of Base. A deployment holding both wallets has
   *      said which chains it CAN pay on, not which it prefers.
   *   4. Then Base.
   */
  const resolveAuth: AuthResolver = async ({ free }): Promise<BlockrunAuth> => {
    const apiKey = await readCredential(apiKeyRef)
    if (apiKey !== undefined) {
      return { mode: 'api-key', apiKey: assertUsableApiKey(apiKey, apiKeyRef), apiUrl: apiKeyUrl }
    }
    // No account key, and this model costs nothing: the gateway answers it
    // `200` with no 402 at all, so the throwaway key below signs nothing and
    // the route works with no credential configured whatsoever.
    //
    // Deliberately the Base gateway even on a Solana-first deployment: no
    // payment happens, so no chain is involved, and sending an unconfigured
    // reader somewhere other than where they have always gone buys nothing.
    if (free) return { mode: 'wallet', privateKey: freeTierKey(), apiUrl }
    const solanaKey = await readCredential(solanaRef)
    if (solanaKey !== undefined) {
      return {
        mode: 'solana-wallet',
        privateKey: assertUsableSolanaKey(solanaKey, solanaRef),
        apiUrl: solanaApiUrl,
      }
    }
    const walletKey = await readCredential(ref)
    if (walletKey !== undefined) {
      return { mode: 'wallet', privateKey: assertUsableWalletKey(walletKey, ref), apiUrl }
    }
    // The diagnostic answers "what do I do now" in the three states a reader is
    // actually in: they have an account and did not wire the key up, they have
    // a funded wallet on disk this route cannot see, or they have neither and
    // have never held a private key. Every path below was run before being
    // recommended.
    //
    // Two wallet locations because the ecosystem has two: the SDK writes
    // ~/.blockrun/.session and ClawRouter writes ~/.openclaw/blockrun/wallet.key.
    throw new LlmError(
      `dsh-clawrouter: no BlockRun credential for provider route "${provider}".`
      + ' This route takes an account key or a wallet key on either chain, and found none.\n'
      + '  Want to try the route first? The models the catalog bills as `free` need no credential at all\n'
      + '  and are reachable right now; this failure is only for the ones that charge.\n'
      + `  Recommended — an API key: sign in at ${PORTAL_URL}, add credit, issue a key under\n`
      + `      ${PORTAL_URL}/dashboard/keys, then export it:\n`
      + `      export ${apiKeyRef}=brk_live_...\n`
      + '  Prefer to pay per call from a wallet? BlockRun accepts an x402 signature on Solana or Base.\n'
      + '  Have a Solana wallet? Export the bs58 secret key:\n'
      + `      export ${solanaRef}=...   (needs @solana/web3.js and @solana/spl-token installed)\n`
      + '  Have a Base wallet? Look in ~/.blockrun/.session or ~/.openclaw/blockrun/wallet.key:\n'
      + `      export ${ref}=$(cat ~/.blockrun/.session)\n`
      + '  Neither? `npx -y @blockrun/clawrouter` generates one and prints its address;\n'
      + '  stop it once you have noted the address, send it a few USDC, then export the key.\n'
      + `  Any of these references can also be stored through the credentials service instead of the environment.`,
      'MISSING_CREDENTIAL',
    )
  }

  const catalog = new BlockrunCatalog(
    provider,
    `${apiUrl}/v1`,
    Date.now,
    config.visionModels,
    config.maxOutputCeiling,
    // Asked for the PAYING credential, because that is the host whose listing
    // this deployment is actually billed against — an account key lists the
    // account's own sheet, and a Solana deployment lists the Solana gateway's.
    // Asking with `free: true` instead looked equivalent and was not: it takes
    // the free-tier short-circuit, which answers with the Base gateway
    // whatever else is configured, so a Solana-only deployment read its
    // catalog from a host it never talks to.
    //
    // The fallback keeps an unconfigured deployment working: with no
    // credential at all the paying branch throws MISSING_CREDENTIAL, and the
    // free branch still yields a public catalog to list.
    async () => {
      try {
        return catalogEndpoint(await resolveAuth({ free: false }))
      } catch {
        return catalogEndpoint(await resolveAuth({ free: true }))
      }
    },
  )
  const meter = new SpendMeter(config.requestFeeUsd ?? DEFAULT_REQUEST_FEE_USD)
  const requestFees = {
    base: config.requestFeeUsd ?? DEFAULT_REQUEST_FEE_USD,
    solana: config.solanaRequestFeeUsd ?? DEFAULT_SOLANA_REQUEST_FEE_USD,
  }
  /**
   * Reads an image attachment as a `data:` URL, when a store is composed.
   *
   * Resolved per request through `ctx.get` rather than captured at load, so a
   * store that mounts later is picked up without a restart. Absent, the
   * adapter refuses image content naming the missing service instead of
   * dropping the attachment.
   */
  const resolveImage = async (ref: ImageAttachmentRef): Promise<string> => {
    const store = ctx.get('attachments')
    if (store === undefined) {
      throw new LlmError(
        'dsh-clawrouter needs the attachment service to send an image; compose @deepseek-ai/dsh-attachment',
        'UNSUPPORTED',
      )
    }
    const stored = await store.readImage(ref)
    return `data:${ref.mediaType};base64,${Buffer.from(stored.data).toString("base64")}`
  }

  const adapter = new BlockrunAdapter({
    provider,
    connection,
    resolveAuth,
    catalog,
    meter,
    resolveImage,
    // Read per call rather than baked into the meter: the two wallet gateways
    // quote the same request differently, so one figure is wrong on one chain.
    requestFee: auth => requestFeeFor(auth, requestFees),
  })

  // Optional child fiber: a composition with no command surface still routes
  // requests; it just has nowhere to print this.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'spend',
      description: `what the ${provider} route has cost this process`,
      handler: () => ({ kind: 'success', text: renderSpend(meter.summary()) }),
    })
  })

  // Registration is an effect: disposing this fiber removes the route, which
  // is what makes hot-reload safe.
  ctx.llm.registerAdapter([provider], adapter)
}

/**
 * A BlockRun account key the account host will accept, checked without ever
 * logging it.
 *
 * Rejected here rather than at the SDK because the failure is the same either
 * way and this one names the reference the reader has to fix. A wallet key
 * pasted into the API-key variable is the mistake this actually catches.
 * @param value - the resolved credential.
 * @param ref - the reference it came from, for the diagnostic.
 * @returns the trimmed key.
 * @throws LlmError `INVALID_CREDENTIAL` when it is not a `brk_` key.
 */
function assertUsableApiKey(value: string, ref: string): string {
  const key = value.trim()
  if (!API_KEY_PATTERN.test(key)) {
    throw new LlmError(
      `dsh-clawrouter: ${ref} is not a usable BlockRun API key (expected it to start with "brk_").`
      + ` Issue one at ${PORTAL_URL}/dashboard/keys.`,
      'INVALID_CREDENTIAL',
    )
  }
  return key
}

/**
 * A Solana secret key the signer can accept, checked without ever logging it.
 *
 * Deliberately a shape check rather than a decode: `@blockrun/llm` takes three
 * encodings and writes a better message than this could for a malformed one.
 * What this catches is the mistake that actually happens — an EVM key pasted
 * into the Solana reference, which is a valid secret of the wrong kind and
 * would otherwise fail somewhere inside a payment call.
 * @param value - the resolved credential.
 * @param ref - the reference it came from, for the diagnostic.
 * @returns the trimmed key.
 * @throws LlmError `INVALID_CREDENTIAL` when it is not a Solana key at all.
 */
function assertUsableSolanaKey(value: string, ref: string): string {
  const key = value.trim()
  if (WALLET_KEY_PATTERN.test(key)) {
    throw new LlmError(
      `dsh-clawrouter: ${ref} holds an EVM (Base) wallet key, not a Solana one.`
      + ' Solana keys are 64 bytes, usually base58 and 86-88 characters.'
      + ' Set it as walletKeyEnv instead, or export a Solana key here.',
      'INVALID_CREDENTIAL',
    )
  }
  if (!SOLANA_WALLET_KEY_PATTERN.test(key)) {
    throw new LlmError(
      `dsh-clawrouter: ${ref} is not a usable Solana secret key. Expected base58`
      + ' (86-88 characters), a 128-character hex string, or a Solana CLI JSON byte array.',
      'INVALID_CREDENTIAL',
    )
  }
  return key
}

/** An EVM private key the signer can actually use, checked without ever logging it. */
function assertUsableWalletKey(value: string, ref: string): string {
  const key = value.trim()
  if (!WALLET_KEY_PATTERN.test(key)) {
    throw new LlmError(
      `dsh-clawrouter: ${ref} is not a usable EVM private key (expected 0x followed by 64 hex characters)`,
      'INVALID_CREDENTIAL',
    )
  }
  return key
}

/** The configured value, or the default when configuration supplied an empty string. */
function nonEmpty(value: string | undefined, fallback: string): string {
  return value !== undefined && value.length > 0 ? value : fallback
}

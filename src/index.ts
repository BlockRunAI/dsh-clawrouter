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
  checkApiKey,
  clearSavedApiKeys,
  DEFAULT_API_KEY_FILES,
  DEFAULT_API_KEY_URL,
  DEFAULT_REQUEST_FEES,
  DEFAULT_SOLANA_API_URL,
  fetchLedgerSummary,
  formatCreditBalance,
  freeTierKey,
  maskApiKey,
  PORTAL_URL,
  readSavedApiKey,
  saveApiKey,
  requestFeeFor,
  SOLANA_WALLET_KEY_PATTERN,
  WALLET_KEY_PATTERN,
} from './auth.ts'
import type { AuthResolver, BlockrunAuth, LedgerSummary } from './auth.ts'
import { BlockrunCatalog, DEFAULT_MAX_TOKENS_CEILING, VERIFIED_VISION_MODELS } from './catalog.ts'
import { renderSpend, SpendMeter } from './spend.ts'
import type { SpendSummary } from './spend.ts'
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
   * Files a saved account key is read from when {@link Config.apiKeyEnv}
   * resolves to nothing, in order.
   *
   * Defaults to the two places ClawRouter keeps one — `~/.blockrun/.api-key`,
   * which `clawrouter login` writes and which is shared across BlockRun
   * products, then `~/.openclaw/blockrun/api-key`. So a machine already logged
   * in with ClawRouter needs nothing exported here. The reference still wins
   * when it is set: an environment variable or managed credential is the more
   * specific instruction. Set this to `[]` to read no file at all.
   *
   * A file that exists but is unreadable, or does not hold a `brk_…` key,
   * fails the request rather than falling through to a wallet.
   */
  apiKeyFiles?: string[]
  /**
   * Credential *reference* naming the environment variable or managed entry
   * that holds the SOLANA wallet key, for paying per call over x402.
   *
   * Checked after {@link Config.apiKeyEnv} and BEFORE
   * {@link Config.walletKeyEnv}. A deployment holding both wallets has said
   * which chains it can pay on rather than which it prefers, and this route
   * picks Solana — the chain BlockRun's own SDK recommends. Its catalog is
   * close to Base's but not identical (three ids differ each way as of
   * 2026-11-21), and this route lists whichever host the credential is on.
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
  apiKeyFiles: z.array(z.string()).default([...DEFAULT_API_KEY_FILES]),
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
  // No WALLET key file is read here: a private key nobody configured, quietly
  // paying for calls, is the confusion the credentials seam exists to prevent.
  // The saved ACCOUNT key is a different thing and is read below — see
  // `accountKey`.
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

  const apiKeyFiles = config.apiKeyFiles ?? DEFAULT_API_KEY_FILES

  /**
   * The account key this deployment is on, and where it came from.
   *
   * The reference first, then the saved files. Until 0.13.0 only the reference
   * was read, on the principle that this route opens no key file of its own —
   * which left a machine that had run `clawrouter login` being told it had no
   * credential, with the key it was asking for sitting in `~/.blockrun`. That
   * file is not a stray secret this route happened to find: it is written by
   * an explicit login, for every BlockRun product on the machine to use.
   *
   * Read per request like every other credential, so `clawrouter login` and
   * `logout` take effect on the next call without a reload.
   * @returns the key and a human-readable source, or undefined on a wallet deployment.
   */
  const accountKey = async (): Promise<{ key: string; source: string } | undefined> => {
    const referenced = await readCredential(apiKeyRef)
    if (referenced !== undefined) return { key: assertUsableApiKey(referenced, apiKeyRef), source: apiKeyRef }
    let saved
    try {
      saved = await readSavedApiKey(apiKeyFiles)
    } catch (error) {
      throw new LlmError(`dsh-clawrouter: ${(error as Error).message}`, 'INVALID_CREDENTIAL', { cause: error })
    }
    return saved === undefined ? undefined : { key: saved.key, source: saved.path }
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
    const account = await accountKey()
    if (account !== undefined) return { mode: 'api-key', apiKey: account.key, apiUrl: apiKeyUrl }
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
      + '      (or `clawrouter login brk_live_...`, which saves it where this route also looks)\n'
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
  /** When this route's meter began counting; the window a ledger read is compared over. */
  const startedAt = new Date()
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

  /**
   * What `/spend` adds on an account-key deployment: which key is in use, and
   * what the account host says is left.
   *
   * The meter above it only knows this process. The balance is the one number
   * that is not local — the same key may be in use on another machine or by
   * ClawRouter itself — and there is no wallet to look at instead. Nothing is
   * printed on a wallet deployment, and a credential problem is left for the
   * next request to report in full rather than restated here.
   */
  const accountLines = async (): Promise<string[]> => {
    let account
    try {
      account = await accountKey()
    } catch {
      return []
    }
    if (account === undefined) return []
    const [check, ledger] = await Promise.all([
      checkApiKey(apiKeyUrl, account.key),
      fetchLedgerSummary(apiKeyUrl, account.key, startedAt),
    ])
    const lines = ['', `BlockRun account key ${maskApiKey(account.key)} (from ${account.source}).`]
    if (check.verdict === 'rejected') {
      lines.push(`The account host REJECTED this key — it is mistyped or revoked. Issue a new one at ${PORTAL_URL}/dashboard/keys.`)
      return lines
    }
    lines.push(
      check.balance === undefined
        ? `Credit could not be read just now; see ${PORTAL_URL}/dashboard/credits.`
        : `Account credit: ${formatCreditBalance(check.balance)}. Top up at ${PORTAL_URL}/dashboard/credits.`,
    )
    if (ledger !== undefined) lines.push(...ledgerLines(ledger, meter.summary()))
    return lines
  }

  /**
   * The account ledger beside this process's own count, for the same window.
   *
   * Not a reconciliation in ClawRouter's sense — there is no per-call journal
   * here to join on request ids — but it answers the question that one exists
   * for: is the account being charged for more than this process did? The
   * ledger running ahead is expected when the key is also in use elsewhere,
   * and is the thing to look at when it is not.
   */
  const ledgerLines = (ledger: LedgerSummary, local: SpendSummary): string[] => {
    const money = (value: number): string => `$${value.toFixed(value > 0 && value < 0.01 ? 6 : 4)}`
    const lines = [
      `Account ledger since this process started: ${money(ledger.usd)} across ${ledger.calls} call${ledger.calls === 1 ? '' : 's'}`
      + ` — this process recorded ${money(local.accountUsd)} across ${local.accountCalls}.`,
    ]
    if (ledger.calls > local.accountCalls) {
      lines.push(
        `  ${ledger.calls - local.accountCalls} of those were not made here: expected if this key is also used on another`
        + ' machine or by another BlockRun tool, and worth a look at the dashboard if it is not.',
      )
    } else if (ledger.calls < local.accountCalls) {
      lines.push('  The ledger is behind this process; recent calls can take a moment to appear.')
    }
    if (ledger.unpricedCalls > 0) {
      lines.push(`  ${ledger.unpricedCalls} ledger call${ledger.unpricedCalls === 1 ? ' is' : 's are'} not priced yet and not in its total.`)
    }
    if (ledger.unavailableDays.length > 0) {
      lines.push(`  The host could not read ${ledger.unavailableDays.join(', ')}; the ledger figure is missing those days.`)
    }
    if (ledger.countedThrough !== undefined) {
      lines.push(`  The ledger figure is exact only through ${ledger.countedThrough}.`)
    }
    return lines
  }

  /**
   * `/blockrun` — which credential this route is on, and the two verbs that
   * change it.
   *
   * `login` and `logout` write the same file `clawrouter login` does, so the
   * change reaches every BlockRun tool on the machine and not only this one.
   * The key is checked against the account host before it is saved: a key the
   * host rejects is not written, and a host that cannot be reached is not
   * treated as a rejection.
   */
  const blockrunCommand = async (rawInput: string): Promise<{ kind: 'success' | 'error'; text: string }> => {
    const [verb = 'status', ...rest] = rawInput.trim().split(/\s+/).filter(part => part.length > 0)
    if (verb === 'login') {
      const key = rest[0]
      if (key === undefined || rest.length !== 1) {
        return { kind: 'error', text: `Usage: /blockrun login brk_live_...   (issue a key at ${PORTAL_URL}/dashboard/keys)` }
      }
      const target = apiKeyFiles[0]
      if (target === undefined) {
        return { kind: 'error', text: '`apiKeyFiles` is empty, so this route reads and writes no key file. Export the key through `apiKeyEnv` instead.' }
      }
      if (!API_KEY_PATTERN.test(key)) {
        return { kind: 'error', text: `That is not a BlockRun API key (expected it to start with "brk_"). Issue one at ${PORTAL_URL}/dashboard/keys.` }
      }
      const check = await checkApiKey(apiKeyUrl, key)
      if (check.verdict === 'rejected') {
        return { kind: 'error', text: `The account host rejected ${maskApiKey(key)} — mistyped or revoked. Nothing was saved.` }
      }
      const saved = await saveApiKey(key, target)
      const shadowed = await readCredential(apiKeyRef)
      return {
        kind: 'success',
        text: [
          `Saved ${maskApiKey(key)} to ${saved} (readable by you only). Every BlockRun tool on this machine will use it.`,
          check.verdict === 'accepted' && check.balance !== undefined
            ? `Account credit: ${formatCreditBalance(check.balance)}.`
            : 'The account host could not be reached to verify it, so it was saved unverified; run /blockrun to check.',
          ...shadowed === undefined ? [] : [`Note: ${apiKeyRef} is also set and takes precedence over the saved key.`],
          'It was typed into this session, so treat it as seen by whatever displays your input; revoke and reissue if that matters.',
        ].join('\n'),
      }
    }
    if (verb === 'logout') {
      const removed = await clearSavedApiKeys(apiKeyFiles)
      const stillSet = await readCredential(apiKeyRef) !== undefined
      return {
        kind: 'success',
        text: [
          removed.length === 0 ? 'No saved BlockRun key to remove.' : `Removed ${removed.join(' and ')}.`,
          stillSet
            ? `${apiKeyRef} is still set, so this route is still on the account; unset it to pay another way.`
            : 'This route now pays from a wallet if one is configured, and otherwise reaches only the free models.',
        ].join('\n'),
      }
    }
    if (verb !== 'status') {
      return { kind: 'error', text: 'Usage: /blockrun [status | login brk_live_... | logout]' }
    }
    const account = await accountLines()
    if (account.length > 0) return { kind: 'success', text: account.slice(1).join('\n') }
    const solana = await readCredential(solanaRef) !== undefined
    const base = await readCredential(ref) !== undefined
    return {
      kind: 'success',
      text: solana || base
        ? `No BlockRun account key. Paying per call from a ${solana ? 'Solana' : 'Base'} wallet (${solana ? solanaRef : ref}).`
          + ` To bill an account instead: /blockrun login brk_live_...`
        : `No BlockRun credential, so only the free models are reachable. Sign in at ${PORTAL_URL}, issue a key, then: /blockrun login brk_live_...`,
    }
  }

  // Optional child fiber: a composition with no command surface still routes
  // requests; it just has nowhere to print this.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'spend',
      description: `what the ${provider} route has cost this process`,
      handler: async () => ({
        kind: 'success',
        text: [renderSpend(meter.summary()), ...await accountLines()].join('\n'),
      }),
    })
    commandCtx.commands.register({
      name: 'blockrun',
      description: `the credential the ${provider} route is on; \`login\` / \`logout\` switch it`,
      input: { hint: '[login brk_live_... | logout]' },
      // The argument to `login` is a bearer credential. Left recorded, it
      // would sit in the session log in plaintext for as long as the log does.
      recordInput: false,
      handler: invocation => blockrunCommand(invocation.rawInput),
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

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
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { BlockrunAdapter } from './adapter.ts'
import type { BlockrunConnection } from './adapter.ts'
import { BlockrunCatalog } from './catalog.ts'
import { renderSpend, SpendMeter } from './spend.ts'
// Side-effect type import: `ctx.commands` exists only once the commands
// package has been imported for its declaration merging.
import type {} from '@deepseek-ai/dsh-commands'

export { BlockrunAdapter } from './adapter.ts'
export { BlockrunCatalog } from './catalog.ts'
export { StreamTranslator } from './translate.ts'
export { renderSpend, SpendMeter, tokenCost } from './spend.ts'
export type { ModelRates, ModelSpend, SpendSummary } from './spend.ts'
export type { BlockrunCatalogModel, BlockrunStreamChunk, ReviewVerdict, RiskMatch } from './types.ts'

/** BlockRun's public API root. */
export const DEFAULT_API_URL = 'https://blockrun.ai/api'

/** Harness route key this plugin registers by default. */
export const DEFAULT_PROVIDER = 'blockrun'

/**
 * Flat per-request x402 fee, as the gateway actually quotes it.
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
   * that holds the EVM wallet key. The value never appears in configuration.
   */
  walletKeyEnv?: string
  /** API root; point at the Solana gateway or a private deployment. */
  apiUrl?: string
  /** Per-request SDK timeout in milliseconds. */
  timeoutMs?: number
  /**
   * Flat per-request fee this deployment is charged, used by `/spend`.
   * Configurable because it is BlockRun's published price rather than a
   * protocol constant, and a stale number here is a wrong total.
   */
  requestFeeUsd?: number
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
  walletKeyEnv: z.string().role('credential-ref').default('BASE_CHAIN_WALLET_KEY'),
  apiUrl: z.string().default(DEFAULT_API_URL),
  timeoutMs: z.natural().default(DEFAULT_TIMEOUT_MS),
  requestFeeUsd: z.number().min(0).default(DEFAULT_REQUEST_FEE_USD),
  auxiliaryModel: z.string(),
})

/**
 * Register the BlockRun adapter.
 * @param ctx - the plugin's context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const provider = nonEmpty(config.provider, DEFAULT_PROVIDER)
  const apiUrl = nonEmpty(config.apiUrl, DEFAULT_API_URL).replace(/\/$/, '')
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

  // Resolved per operation, never cached: a wallet key rotated in the managed
  // store must reach the very next request without reloading this plugin.
  const resolveWalletKey = async (): Promise<string> => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableWalletKey(hit.value, ref)
    } else {
      // Without the seam there is no managed store to rank against, so the
      // launching environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) return assertUsableWalletKey(ambient.value, ref)
    }
    throw new LlmError(
      `dsh-clawrouter: no wallet key for provider route "${provider}"; store ${ref} through the credentials`
      + ` service, or export ${ref} in the launching environment. BlockRun authenticates with a wallet`
      + ' signature — there is no API key to paste.',
      'MISSING_CREDENTIAL',
    )
  }

  const catalog = new BlockrunCatalog(provider, `${apiUrl}/v1`)
  const meter = new SpendMeter(config.requestFeeUsd ?? DEFAULT_REQUEST_FEE_USD)
  const adapter = new BlockrunAdapter({ provider, connection, resolveWalletKey, catalog, meter })

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

/** An EVM private key the signer can actually use, checked without ever logging it. */
function assertUsableWalletKey(value: string, ref: string): string {
  const key = value.trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
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

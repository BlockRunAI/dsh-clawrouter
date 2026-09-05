/**
 * How this route authenticates: a BlockRun account key, or a wallet signature.
 *
 * Two credential planes reach the same catalog of models through two different
 * hosts, and the difference is not cosmetic — it decides which host is called,
 * what a call costs, and where the reader goes when a call is refused for
 * money.
 *
 * - **API key** (`brk_live_…`) reaches `api.blockrun.ai`. The account is
 *   prepaid and billed post-hoc at ACTUAL token usage against the published
 *   price sheet, with no per-call minimum and no per-call fee. Every call is
 *   written to the account ledger, so `user.blockrun.ai/dashboard` is the
 *   authority on what was spent.
 * - **Solana wallet** (a bs58 secret key) reaches `sol.blockrun.ai/api` and
 *   pays each call over x402: the gateway answers `402` with a quote, the
 *   client signs an SPL TransferChecked authorization locally, and the retry
 *   carries it.
 * - **Base wallet** (an EVM private key) reaches `blockrun.ai/api` and does the
 *   same thing with an EIP-3009 authorization.
 *
 * Both wallet paths quote a flat per-request figure that settles whatever the
 * model then does, and both serve the same catalog — verified identical, id
 * for id, on 2026-09-05. What differs is the chain the USDC moves on and what
 * the gateway quotes for a call: `2000` (µUSDC) on Base against `1000` on
 * Solana, measured for the same request on the same model. That is not a
 * marketing line, it is what `/spend` has to know to report a total that is
 * not off by a factor of two.
 *
 * The credentials are mutually exclusive by construction — `BlockrunClient`
 * throws when given both a key and a wallet — so this module resolves exactly
 * one, in this order:
 *
 *   1. **API key.** An account key is the credential someone chose on purpose,
 *      and silently paying from a wallet they also happened to have exported
 *      would spend money they did not mean to spend on that call.
 *   2. **Solana wallet**, ahead of Base. A deployment holding both wallets has
 *      said which chains it can pay on, not which it prefers; this route picks
 *      Solana, which is also the chain BlockRun's own SDK recommends.
 *   3. **Base wallet.**
 *
 * @module dsh-clawrouter/auth
 */

import { randomBytes } from 'node:crypto'

/** Account-billed API root; `brk_live_…` keys are only valid here. */
export const DEFAULT_API_KEY_URL = 'https://api.blockrun.ai'

/** Where an account is created, keys are issued, and credit is topped up. */
export const PORTAL_URL = 'https://user.blockrun.ai'

/**
 * The shape of a BlockRun account key.
 *
 * Matches `@blockrun/llm`'s own check so a key this route accepts is never
 * rejected one layer down with a worse message.
 */
export const API_KEY_PATTERN = /^brk_[A-Za-z0-9_-]+$/

/** An EVM private key the x402 signer can actually use. */
export const WALLET_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/

/** BlockRun's Solana gateway; x402 settles in SPL USDC there. */
export const DEFAULT_SOLANA_API_URL = 'https://sol.blockrun.ai/api'

/**
 * A Solana secret key in any of the three forms `@blockrun/llm` decodes.
 *
 * Deliberately permissive, and deliberately NOT the SDK's decoder: this is a
 * shape check that runs before a request goes out, so a mistyped variable
 * fails locally naming the reference rather than somewhere inside a payment
 * call. Anything that gets past it is the SDK's to reject, with a better
 * message than this module could write.
 *
 * The three accepted forms are base58 (the standard 64-byte key, 86-88
 * characters), a 128-character hex string with or without `0x`, and the Solana
 * CLI's JSON byte array.
 */
export const SOLANA_WALLET_KEY_PATTERN =
  /^(?:\[[\d,\s]+\]|(?:0[xX])?[0-9a-fA-F]{128}|[1-9A-HJ-NP-Za-km-z]{86,88})$/

/**
 * What one request costs on each wallet gateway, as the gateway itself quotes.
 *
 * Measured 2026-09-05 against a `deepseek/deepseek-chat` request capped at 5
 * output tokens: Base answered `{"amount":"2000"}` and Solana `{"amount":"1000"}`,
 * both in µUSDC. Carried per chain rather than as one number because `/spend`
 * multiplies it by the call count, so a single default is simply wrong on one
 * of the two chains.
 */
export const DEFAULT_REQUEST_FEES = { base: 0.002, solana: 0.001 } as const

/** One resolved credential, and the host it is valid against. */
export type BlockrunAuth =
  /** Account billing: exact token usage, no per-call fee, ledgered to the account. */
  | { readonly mode: 'api-key'; readonly apiKey: string; readonly apiUrl: string }
  /** x402 on Solana: a flat quote per request, signed locally, settled in SPL USDC. */
  | { readonly mode: 'solana-wallet'; readonly privateKey: string; readonly apiUrl: string }
  /** x402 on Base: the same, settled in Base USDC by an EIP-3009 authorization. */
  | { readonly mode: 'wallet'; readonly privateKey: string; readonly apiUrl: string }

/**
 * What one request costs under this credential, or nothing when it is not
 * quoted per request at all.
 *
 * An account key returns `undefined`: it is billed from the tokens the call
 * actually used, and there is no per-call figure to multiply.
 * @param auth - the resolved credential.
 * @param fees - the per-chain quotes this deployment is configured with.
 * @returns the flat per-request price, or undefined for account billing.
 */
export function requestFeeFor(
  auth: BlockrunAuth,
  fees: { base: number; solana: number } = DEFAULT_REQUEST_FEES,
): number | undefined {
  if (auth.mode === 'api-key') return undefined
  return auth.mode === 'solana-wallet' ? fees.solana : fees.base
}

/** What the adapter asks for, once per request. */
export interface AuthRequest {
  /**
   * Whether the catalog bills this model at zero.
   *
   * A free model needs no credential at all on either wallet gateway, which is
   * what keeps the "try it right now" path open — both answer a
   * `billing_mode: "free"` model `200` with no 402 at all. It does NOT skip the
   * API key when one is configured: `api.blockrun.ai` answers an
   * unauthenticated request with `401` whatever the model costs, and a call
   * made on the account is a call the account ledger can show.
   */
  readonly free: boolean
}

/** Resolves the credential for one request. */
export type AuthResolver = (request: AuthRequest) => Promise<BlockrunAuth>

/** Lazily generated once per process; see {@link freeTierKey}. */
let ephemeralKey: string | undefined

/**
 * A throwaway key standing in for a wallet on an unauthenticated free-tier
 * request.
 *
 * `BlockrunClient` requires a credential in its constructor — in wallet mode
 * it derives the address it would pay from — and refuses to be built without
 * one, falling back to reading `BASE_CHAIN_WALLET_KEY` from the ambient
 * environment if the option is omitted. Neither is acceptable here: a free
 * model needs no wallet, and silently picking up whatever key happens to be
 * exported is exactly the shadowing that the credentials seam exists to
 * prevent.
 *
 * So a random one is generated instead. It is never used to sign anything: the
 * signing path runs only when the gateway answers `402`, and a free model
 * answers `200` — verified against the live gateway, where an unpaid request
 * to `nvidia/nemotron-3.5-lightning` returned `200` and the same request to
 * `deepseek/deepseek-chat` returned `402`. Nothing is derived from it that
 * outlives the process, and no funds can reach an address nobody is told.
 *
 * Generated once rather than per request, because deriving the address costs a
 * secp256k1 multiplication and a fresh key buys nothing when it signs nothing.
 * 32 random bytes are a valid secp256k1 scalar with probability
 * 1 - 2^-128; the remainder is not worth a retry loop that could never be
 * covered by a test.
 *
 * @returns the process's ephemeral free-tier key.
 */
export function freeTierKey(): string {
  ephemeralKey ??= `0x${randomBytes(32).toString('hex')}`
  return ephemeralKey
}

/**
 * The catalog endpoint a resolved credential can read.
 *
 * `api.blockrun.ai/v1/models` answers `401` unauthenticated, so an API-key
 * deployment cannot share the wallet gateway's anonymous catalog read. It also
 * should not: the account's own listing is the one whose prices `/spend` is
 * about to bill from.
 * @param auth - the resolved credential.
 * @returns the `/v1` base and any headers the read needs.
 */
export function catalogEndpoint(auth: BlockrunAuth): { baseURL: string; headers?: Record<string, string> } {
  const baseURL = `${auth.apiUrl.replace(/\/$/, '')}/v1`
  if (auth.mode !== 'api-key') return { baseURL }
  return { baseURL, headers: { authorization: `Bearer ${auth.apiKey}` } }
}

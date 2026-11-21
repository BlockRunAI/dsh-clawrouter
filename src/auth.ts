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
 * Both wallet paths quote each request up front and settle that quote
 * whatever the model then does. They no longer serve the same catalog: it was
 * identical id for id on 2026-09-05, and on 2026-11-21 three ids were only on
 * Base and three only on Solana, which is why the catalog is read from the
 * host the credential is valid on. What also differs is the chain the USDC
 * moves on and what the gateway quotes: Base adds a flat $0.001 to every
 * quote that Solana does not, so the floor is `2000` (µUSDC) against `1000`
 * and every larger quote is `1000` apart, measured for the same requests on
 * the same models. `/spend` reads the signed amount for that reason rather
 * than assuming either.
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

import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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

/**
 * Where a saved account key is looked for when the credential reference
 * resolves to nothing, in order.
 *
 * These are ClawRouter's two locations, and they are here for the same reason
 * they are there: `clawrouter login brk_live_…` writes the first one, labelled
 * as shared across BlockRun products, and a person who has done that has
 * already told this machine how they want to pay. Asking them to export the
 * same key again under an environment variable — and failing with "no
 * credential" until they do — is this route not honouring a decision that was
 * made. The second is ClawRouter's older location.
 *
 * `~` is expanded per read, so the files of whoever is running the process are
 * the ones consulted.
 */
export const DEFAULT_API_KEY_FILES: readonly string[] = [
  '~/.blockrun/.api-key',
  '~/.openclaw/blockrun/api-key',
]

/** A saved key, and the file it was read from. */
export interface SavedApiKey {
  readonly key: string
  /** The path as configured, `~` unexpanded, so a diagnostic names what the reader typed. */
  readonly path: string
}

/**
 * The saved account key, from the first file that holds one.
 *
 * Two failures are deliberately loud, both taken from ClawRouter, because the
 * quiet alternative spends the wrong money:
 *
 * - **A file that exists and cannot be read.** Only `ENOENT` means "no key
 *   saved". A permissions or I/O error is a credential this route was told
 *   about and cannot see, and falling through would pay from a wallet the
 *   reader meant to leave alone.
 * - **A file whose content is not a key.** Skipping it would move on to the
 *   next source, which could be a different account's key or a wallet.
 *
 * An empty file counts as absent: it cannot be mistaken for anyone's
 * credential, and it is what a half-finished `logout` leaves behind.
 * @param paths - candidate files, `~`-prefixed or absolute.
 * @returns the key and where it came from, or undefined when none is saved.
 * @throws Error naming the file, never its content, for the two cases above.
 */
export async function readSavedApiKey(
  paths: readonly string[] = DEFAULT_API_KEY_FILES,
): Promise<SavedApiKey | undefined> {
  for (const path of paths) {
    if (path.length === 0) continue
    const resolved = expandHome(path)
    let content: string
    try {
      content = (await readFile(resolved, 'utf8')).trim()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error(
        `Cannot read the BlockRun API key file ${path}; refusing to fall back to another account or a wallet.`,
        { cause: error },
      )
    }
    if (content.length === 0) continue
    if (!API_KEY_PATTERN.test(content)) {
      throw new Error(
        `${path} does not contain a BlockRun API key (expected it to start with "brk_").`
        + ` Save a valid one with \`clawrouter login\`, or remove the file to pay another way.`
        + ' Refusing to fall back silently: the next source could bill a different account or spend from a wallet.',
      )
    }
    return { key: content, path }
  }
  return undefined
}

/** `~` and `~/…` against the home of whoever is running; anything else unchanged. */
function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}

/**
 * Save an account key where every BlockRun product on the machine looks.
 *
 * Written `0600`: it is a bearer credential for the reader's money.
 *
 * The key goes into a NEW file created exclusively with that mode, which is
 * then renamed over the destination. Writing the destination in place is not
 * enough: `writeFile`'s `mode` applies only when it creates the file, so
 * logging in over an existing `0644` key file kept `0644` and left the new
 * key readable by every local user while this route said otherwise. Renaming
 * a fresh file replaces the old inode and its permissions together, and a
 * crash mid-write leaves the previous key intact rather than a truncated one.
 *
 * A directory this creates is `0700`. An existing one is left as it is — it
 * may be shared with other tools — but the file inside it is owner-only
 * either way, which is what keeps the key unreadable.
 * @param key - the key to save.
 * @param path - destination, `~`-prefixed or absolute.
 * @returns the path as given, for the confirmation line.
 * @throws Error when `key` is not a BlockRun key; nothing is written.
 */
export async function saveApiKey(key: string, path: string = DEFAULT_API_KEY_FILES[0]!): Promise<string> {
  const trimmed = key.trim()
  if (!API_KEY_PATTERN.test(trimmed)) {
    throw new Error(`Not a BlockRun API key: expected it to start with "brk_". Issue one at ${PORTAL_URL}/dashboard/keys.`)
  }
  const resolved = expandHome(path)
  await mkdir(dirname(resolved), { recursive: true, mode: 0o700 })
  const staging = `${resolved}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    // `wx`: fail rather than reuse a file someone else created at this name.
    await writeFile(staging, `${trimmed}\n`, { mode: 0o600, flag: 'wx' })
    // The umask can only remove bits, so this is already 0600; set it anyway
    // so the guarantee does not rest on that.
    await chmod(staging, 0o600)
    await rename(staging, resolved)
  } catch (error) {
    await rm(staging, { force: true })
    throw error
  }
  return path
}

/**
 * A stable, non-reversible label for one account key.
 *
 * Lets the meter keep each key's calls apart without holding the key itself:
 * a process that switched accounts with `/blockrun login` must compare each
 * account's ledger against that account's calls, not against everything it
 * ever sent.
 * @param key - the account key.
 * @returns 16 hex characters of its SHA-256.
 */
export function accountFingerprint(key: string): string {
  return createHash('sha256').update(key.trim()).digest('hex').slice(0, 16)
}

/**
 * Remove every saved key.
 *
 * Every file, not the first: a key left in the older location would be picked
 * up on the very next request, and "logout" that leaves the account in use is
 * worse than no logout at all.
 * @param paths - the files {@link readSavedApiKey} consults.
 * @returns the paths actually removed, as given.
 */
export async function clearSavedApiKeys(paths: readonly string[] = DEFAULT_API_KEY_FILES): Promise<string[]> {
  const removed: string[] = []
  for (const path of paths) {
    if (path.length === 0) continue
    const resolved = expandHome(path)
    try {
      await readFile(resolved)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error(`Cannot read the BlockRun API key file ${path}, so it was not removed.`, { cause: error })
    }
    await rm(resolved, { force: true })
    removed.push(path)
  }
  return removed
}

/**
 * A key rendered for a status line: enough to tell two apart, never enough to
 * use. The portal labels a key by its first 14 characters, so the head matches
 * what the dashboard shows.
 * @param key - the full key.
 * @returns the masked form.
 */
export function maskApiKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length <= 18) return `${trimmed.slice(0, 8)}…`
  return `${trimmed.slice(0, 14)}…${trimmed.slice(-4)}`
}

/**
 * What `GET /v1/credits` reports for the calling key.
 *
 * `remainingUsd` is nullable and that is not an error path: an account in
 * `ungated` billing has no granted allowance to draw down, so the host reports
 * `remaining_usd: null` and only `spent_usd` means anything. Printing that as
 * "$0.00" would tell such a reader they are out of money when they are not.
 */
export interface CreditBalance {
  readonly billingMode?: string
  readonly spentUsd: number | null
  readonly remainingUsd: number | null
  readonly blocked: boolean
  readonly blockedReason?: string
}

/** How long `/spend` waits on the account host before printing without the balance. */
export const CREDIT_FETCH_TIMEOUT_MS = 5_000

/**
 * The account's credit position, or undefined when it cannot be read.
 *
 * Never throws: this decorates a status command, and a blip on the account
 * host must not turn "what have I spent" into an error. The endpoint and its
 * field names are the ones ClawRouter's `status` reads.
 * @param apiUrl - the account API root.
 * @param apiKey - the account key, sent as a bearer token to that host only.
 * @param timeoutMs - deadline for the read.
 * @returns the balance, or undefined on any failure.
 */
export async function fetchCreditBalance(
  apiUrl: string,
  apiKey: string,
  timeoutMs: number = CREDIT_FETCH_TIMEOUT_MS,
): Promise<CreditBalance | undefined> {
  return (await checkApiKey(apiUrl, apiKey, timeoutMs)).balance
}

/** What the account host said about a key. */
export interface ApiKeyCheck {
  /**
   * `accepted` — the host answered for this key. `rejected` — it answered
   * `401`/`403`, so the key is mistyped or revoked. `unknown` — nothing
   * conclusive came back, which says nothing about the key.
   */
  readonly verdict: 'accepted' | 'rejected' | 'unknown'
  readonly balance?: CreditBalance
}

/**
 * Ask the account host whether it knows a key, and what the account holds.
 *
 * The three verdicts are kept apart because they call for different things: a
 * rejected key should not be saved, while a host that could not be reached is
 * no reason to refuse a key that may be perfectly good.
 * @param apiUrl - the account API root.
 * @param apiKey - the key, sent as a bearer token to that host only.
 * @param timeoutMs - deadline for the read.
 * @returns the verdict, with the balance when the host gave one.
 */
export async function checkApiKey(
  apiUrl: string,
  apiKey: string,
  timeoutMs: number = CREDIT_FETCH_TIMEOUT_MS,
): Promise<ApiKeyCheck> {
  const body = await accountRead(apiUrl, apiKey, 'credits', timeoutMs)
  if (body === 'rejected') return { verdict: 'rejected' }
  if (body === undefined) return { verdict: 'unknown' }
  const amount = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null
  return {
    verdict: 'accepted',
    balance: {
      ...typeof body['billing_mode'] === 'string' ? { billingMode: body['billing_mode'] } : {},
      spentUsd: amount(body['spent_usd']),
      remainingUsd: amount(body['remaining_usd']),
      blocked: body['blocked'] === true,
      ...typeof body['blocked_reason'] === 'string' ? { blockedReason: body['blocked_reason'] } : {},
    },
  }
}

/**
 * One authenticated GET against the account host.
 * @returns the decoded object, `'rejected'` for 401/403, undefined otherwise.
 */
async function accountRead(
  apiUrl: string,
  apiKey: string,
  path: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | 'rejected' | undefined> {
  try {
    const response = await fetch(`${apiUrl.replace(/\/$/, '')}/v1/${path}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
      // A bearer token must not follow a redirect to wherever Location says.
      redirect: 'error',
    })
    if (response.status === 401 || response.status === 403) return 'rejected'
    if (!response.ok) return undefined
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** What the account ledger holds for a window, from `GET /v1/usage/summary`. */
export interface LedgerSummary {
  readonly usd: number
  readonly calls: number
  /** Calls the ledger has recorded and not yet priced; they are in `calls`, not in `usd`. */
  readonly unpricedCalls: number
  /** Days the host could not read. A hole, never a zero. */
  readonly unavailableDays: readonly string[]
  /** Set when the figures stop short of now; ISO timestamp they are exact through. */
  readonly countedThrough?: string
}

/**
 * The account ledger's own total since a moment.
 *
 * This is the authority on what was charged; the meter in this process is only
 * what it saw. Read so `/spend` can put the two side by side — the nearest
 * thing this route has to ClawRouter's `reconcile`, without a per-call journal
 * to join on.
 * @param apiUrl - the account API root.
 * @param apiKey - the account key.
 * @param from - start of the window.
 * @param timeoutMs - deadline for the read.
 * @returns the summary, or undefined when it cannot be read.
 */
export async function fetchLedgerSummary(
  apiUrl: string,
  apiKey: string,
  from: Date,
  timeoutMs: number = CREDIT_FETCH_TIMEOUT_MS,
): Promise<LedgerSummary | undefined> {
  const query = new URLSearchParams({ from: from.toISOString(), to: new Date().toISOString() })
  const body = await accountRead(apiUrl, apiKey, `usage/summary?${query.toString()}`, timeoutMs)
  if (body === undefined || body === 'rejected') return undefined
  const totals = body['totals']
  if (typeof totals !== 'object' || totals === null) return undefined
  const { usd, calls, unpriced_calls: unpriced } = totals as Record<string, unknown>
  if (typeof usd !== 'number' || typeof calls !== 'number') return undefined
  const days = body['unavailable_days']
  const through = body['counted_through']
  return {
    usd,
    calls,
    unpricedCalls: typeof unpriced === 'number' ? unpriced : 0,
    unavailableDays: Array.isArray(days) ? days.filter((day): day is string => typeof day === 'string') : [],
    ...typeof through === 'string' ? { countedThrough: through } : {},
  }
}

/**
 * One line saying where the account stands.
 * @param balance - what the account host reported.
 * @returns e.g. `$41.20 remaining (spent $8.80)`.
 */
export function formatCreditBalance(balance: CreditBalance): string {
  const money = (value: number | null): string | undefined =>
    value === null ? undefined : `$${value.toFixed(value > 0 && value < 0.01 ? 6 : 2)}`
  const remaining = money(balance.remainingUsd)
  const spent = money(balance.spentUsd)
  const position = remaining !== undefined
    ? `${remaining} remaining${spent === undefined ? '' : ` (spent ${spent})`}`
    // No allowance to run down, so spend to date is the figure that means
    // anything.
    : `${spent === undefined ? 'balance not reported' : `spent ${spent}`} — `
      + (balance.billingMode === 'ungated' ? 'no prepaid limit' : balance.billingMode ?? 'billing mode not reported')
  return balance.blocked
    ? `${position} — BLOCKED${balance.blockedReason === undefined ? '' : `: ${balance.blockedReason}`}`
    : position
}

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
 * An API-key deployment does not share the wallet gateway's anonymous catalog
 * read: the account's own listing is the one whose prices `/spend` is about
 * to bill from, and it is not identical to the wallet gateways'. The key is
 * sent even though `api.blockrun.ai/v1/models` now answers an anonymous read
 * `200` (it answered `401` until late 2026) — a read made for an account
 * should be made as that account.
 * @param auth - the resolved credential.
 * @returns the `/v1` base and any headers the read needs.
 */
export function catalogEndpoint(auth: BlockrunAuth): { baseURL: string; headers?: Record<string, string> } {
  const baseURL = `${auth.apiUrl.replace(/\/$/, '')}/v1`
  if (auth.mode !== 'api-key') return { baseURL }
  return { baseURL, headers: { authorization: `Bearer ${auth.apiKey}` } }
}

/**
 * The BlockRun `LlmAdapter`: one harness provider route reaching every model
 * BlockRun serves, under either of the two credentials it accepts.
 *
 * Almost every request is paid per call in USDC over x402 — the gateway answers
 * an unpaid request with `402`, the client signs an EIP-3009 authorization
 * locally, and the retry carries it. That handshake is why this route cannot be
 * expressed as a static-credential gateway row: no header value exists ahead of
 * the request.
 *
 * The exception is the free tier, which never reaches that handshake at all:
 * the gateway answers a `billing_mode: "free"` model with `200` and no `402`,
 * so those models need no wallet and cost nothing. See `freeTierKey` in
 * {@link ./auth.ts}.
 *
 * A deployment holding a BlockRun account key takes a different host entirely.
 * `api.blockrun.ai` authenticates with `Authorization: Bearer brk_live_…`,
 * never opens a 402 handshake, and bills the account post-hoc at actual token
 * usage — no per-call minimum, no per-call fee. The wallet path is untouched
 * by its presence: {@link ./auth.ts | the resolver} answers with exactly one
 * credential per request, so a deployment that configured no key still pays
 * the way it always did. What changes is which numbers `/spend` may report;
 * see {@link CallPricing}.
 *
 * @module dsh-clawrouter/adapter
 */

import { BlockrunClient, SolanaLLMClient } from '@blockrun/llm'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { PORTAL_URL } from './auth.ts'
import type { AuthResolver, BlockrunAuth } from './auth.ts'
import { BlockrunCatalog, suggestModels, toModelInfo } from './catalog.ts'
import { httpErrorCode } from './http-error.ts'
export { httpErrorCode } from './http-error.ts'

/**
 * Whether a failed request was, by our own accounting, too big for the model.
 *
 * The gateway sanitizes upstream errors down to `{"message":"API request
 * failed"}`, so the wording the text detectors need never arrives — a real
 * overflow measured against the live gateway matched none of them. Request size
 * is the only signal left.
 *
 * It is checked ONLY after a 400 and only against the model's own declared
 * window, so an ordinary bad-parameter 400 on a normal-sized prompt is
 * untouched. The remaining false positive — an oversized prompt rejected for
 * some unrelated reason — asks the harness to compact a request that was too
 * large anyway, which is the right move regardless of why it failed.
 * @param bodyChars - serialized request size in characters.
 * @param contextWindow - the model's declared capacity, when known.
 * @returns whether the request exceeded that capacity.
 */
export function looksOversized(bodyChars: number, contextWindow: number | undefined): boolean {
  if (contextWindow === undefined || contextWindow <= 0) return false
  return bodyChars / CHARS_PER_TOKEN > contextWindow
}
import { buildRequestBody } from './serialize.ts'
import type { ImageResolver } from './serialize.ts'
import { StreamTranslator } from './translate.ts'
import type { BlockrunStreamChunk } from './types.ts'
import type { CallPricing, ModelRates, SpendMeter } from './spend.ts'

/** Path under the API root that serves OpenAI-compatible streaming chat. */
const CHAT_PATH = '/v1/chat/completions'

/** Everything one request needs, resolved before any network call. */
export interface BlockrunConnection {
  /** API root, e.g. `https://blockrun.ai/api`. */
  apiUrl: string
  /** Per-request SDK timeout in milliseconds. */
  timeoutMs: number
  /**
   * Model serving the harness's maintenance calls — compaction and session
   * titles — instead of the conversation's own. Absent leaves them on the
   * conversation model, which is the harness default.
   */
  auxiliaryModel?: string
}

/** Constructor dependencies, kept explicit so the adapter owns no lifecycle. */
export interface BlockrunAdapterOptions {
  /** Harness route key this adapter is registered under. */
  provider: string
  /** Reads the current connection; called once per operation, never cached. */
  connection: () => BlockrunConnection
  /**
   * Resolves the credential for one request — an account key or a wallet key —
   * or throws `LlmError('MISSING_CREDENTIAL')` when neither is configured.
   */
  resolveAuth: AuthResolver
  /** Model catalog for this route. */
  catalog: BlockrunCatalog
  /** Counts what completed calls cost; omitted leaves spend uncounted. */
  meter?: SpendMeter
  /**
   * What one request is quoted at under a given credential, or undefined when
   * it is not quoted per request at all.
   *
   * A function rather than a number because the two wallet gateways quote the
   * same request differently — `2000` µUSDC on Base against `1000` on Solana,
   * measured — so a meter holding one figure reports double or half on one of
   * them. Omitted falls back to the meter's own default.
   */
  requestFee?: (auth: BlockrunAuth) => number | undefined
  /**
   * Reads image attachments for vision requests.
   *
   * Omitted when no attachment service is composed, which makes an image
   * request fail with `UNSUPPORTED` naming the missing service rather than
   * dropping the attachment.
   */
  resolveImage?: ImageResolver
}

/** Streams harness requests through the BlockRun gateway. */
export class BlockrunAdapter extends LlmAdapter {
  readonly #options: BlockrunAdapterOptions

  /** @param options - route key, connection reader, credential resolver, and catalog. */
  constructor(options: BlockrunAdapterOptions) {
    super()
    this.#options = options
  }

  /**
   * Display metadata for the route.
   * @param provider - the registered route key.
   * @returns the route's id and human-readable name.
   */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'BlockRun' }
  }

  /**
   * Every model the gateway currently serves.
   * @param _provider - the registered route key; this adapter owns exactly one.
   * @returns selector metadata for each catalog model.
   */
  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.#options.catalog.list()
    return models.map(toModelInfo)
  }

  /**
   * One exact model's authoritative descriptor.
   * @param _provider - the registered route key.
   * @param model - BlockRun model id.
   * @param signal - cancels the catalog read.
   * @returns identity, capacity, and configured output cap.
   */
  override async resolveModel(
    _provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.#options.catalog.resolve(model, signal)
  }

  /**
   * Refuse a reasoning request for a model that does not reason.
   *
   * `openai/gpt-4o` returns HTTP 400 for `reasoning_effort` **after taking
   * payment**, measured against the live gateway. Checking the catalog first
   * turns that into a free, local, actionable failure. Dropping the field
   * instead would answer a request for thinking without any.
   *
   * @param model - the gateway model id.
   * @param signal - cancellation for the catalog read.
   * @throws LlmError `UNSUPPORTED` when the model declares no reasoning efforts.
   */
  async #assertReasons(model: string, signal: AbortSignal | undefined): Promise<void> {
    const info = await this.#options.catalog.resolve(model, signal)
    if (info?.reasoning !== undefined && info.reasoning.efforts.length > 0) return
    throw new LlmError(
      `dsh-clawrouter: "${model}" does not support reasoning effort on BlockRun; `
      + 'omit reasoningEffort or select a model the catalog tags "reasoning"',
      'UNSUPPORTED',
    )
  }

  /**
   * Stream one model response.
   * @param options - the harness request.
   * @returns harness chunks in protocol order.
   * @throws LlmError for credential, transport, and protocol failures.
   */
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.#options.connection()
    const model = auxiliaryModelFor(options, connection)
    await this.#assertServable(model, options.signal)
    if (options.reasoningEffort !== undefined) await this.#assertReasons(model, options.signal)
    // Which model was named decides whether a credential is needed at all, so
    // this has to come after the model is resolved. The credential used to be
    // checked first, on the reasoning that a deployment with no wallet had a
    // more fundamental problem than whichever model it named — which was true
    // while every model cost money. It stopped being true: as of 2026-08-30
    // the catalog bills seven of the seventy chat models as free and the
    // gateway answers those unpaid, so demanding a funded wallet before one of
    // them closed off the whole "no accounts, no API keys, try it now" path.
    //
    // The catalog read this needs is not an extra one; `#assertServable` above
    // has already made it, and answers from the same cache.
    const free = await this.#options.catalog.isFree(model, options.signal)
    const auth = await this.#options.resolveAuth({ free })
    const body = await buildRequestBody(
      model === options.model ? options : { ...options, model },
      this.#options.resolveImage,
    )
    // Captured before dispatch: if this request comes back 400, its size
    // against the model's own declared window is the only overflow signal the
    // gateway leaves us.
    const bodyChars = JSON.stringify(body).length
    const capacity = await this.#declaredContextWindow(model, options.signal)

    // Exactly one credential reaches the SDK, and the client class follows the
    // chain rather than the other way round: an EIP-3009 signature is not an
    // SPL TransferChecked one, so `SolanaLLMClient` is a different signer, not
    // a different base URL. The host is not interchangeable either — a
    // `brk_live_…` key sent to a wallet gateway is answered `402` rather than
    // served — so it travels with the credential that is valid against it.
    const client: StreamingClient = auth.mode === 'solana-wallet'
      ? new SolanaLLMClient({
        privateKey: auth.privateKey,
        apiUrl: auth.apiUrl,
        timeout: connection.timeoutMs,
      })
      : new BlockrunClient(
        auth.mode === 'api-key'
          ? { apiKey: auth.apiKey, apiUrl: auth.apiUrl, timeout: connection.timeoutMs }
          : { privateKey: auth.privateKey, apiUrl: auth.apiUrl, timeout: connection.timeoutMs },
      )
    // The billing scheme is a property of the CREDENTIAL, not of the plugin's
    // configuration: an account key is invoiced at exact usage while a wallet
    // settles a flat quote, and reporting either total under the other's rules
    // is a number the reader cannot reconcile against anything.
    // Absent leaves the fee to the meter's own default rather than computing
    // one here: a caller that constructed `SpendMeter(price)` and wired no
    // per-chain function said what a request costs on their deployment, and
    // quietly overriding it would make that constructor argument a decoration.
    const feeUsd = this.#options.requestFee?.(auth)
    const pricing: CallPricing = auth.mode === 'api-key'
      ? { kind: 'per-token', ...ratesFor(this.#options.catalog, model) }
      : { kind: 'per-request', ...feeUsd === undefined ? {} : { feeUsd } }

    const translator = new StreamTranslator()
    const iterator = client.stream<BlockrunStreamChunk>(CHAT_PATH, body)[Symbol.asyncIterator]()
    // The model that actually answered, when it is not the one that was asked
    // for. The gateway substitutes silently in three places and the headers it
    // sets for two of them do not reach us through the SDK, so the per-chunk
    // `model` field is the only signal available. First mismatch wins: it
    // identifies the substitution, and a later chunk cannot un-substitute it.
    let servedModel: string | undefined
    try {
      for (;;) {
        throwIfAborted(options.signal)
        let next: IteratorResult<BlockrunStreamChunk>
        try {
          next = await iterator.next()
        } catch (error) {
          throw asLlmError(
            error,
            looksOversized(bodyChars, capacity),
            await paymentContext(auth, client, free, model),
          )
        }
        if (next.done === true) break
        // Checked again after the await: a turn cancelled while this read was
        // outstanding must not emit the chunk it was waiting on.
        throwIfAborted(options.signal)
        const served = next.value.model
        if (servedModel === undefined && typeof served === 'string' && served.length > 0 && served !== model) {
          servedModel = served
        }
        yield * this.#metered(model, free, servedModel, pricing, translator.accept(next.value))
      }
      // The terminal flush is metered too, and it is the one that counts: the
      // translator BUFFERS usage and emits it from `end()`, so watching only
      // the per-chunk output recorded nothing at all. It is also the flush that
      // sees the final `servedModel`, since usage arrives last.
      yield * this.#metered(model, free, servedModel, pricing, translator.end())
    } finally {
      // Terminating the generator releases the SDK's reader. The in-flight
      // HTTP request is not itself cancellable until `BlockrunClient.stream`
      // accepts an AbortSignal; until then an abort stops delivery here and
      // the socket closes when the SDK's own timeout elapses.
      await iterator.return?.(undefined).catch(() => {
        // The SDK's cleanup path is best-effort and nothing downstream can act
        // on its failure; the caller's own abort or error is the real outcome.
      })
    }
  }

  /**
   * Pass chunks through, counting any usage record among them.
   *
   * Counted from the provider's own report, so a call that never sent one is
   * never guessed at — it simply does not appear in the total.
   * @param model - the model the request asked for.
   * @param free - whether the gateway served it without payment.
   * @param servedModel - the model that answered, when it was a different one.
   * @param pricing - how this credential's calls are charged.
   * @param chunks - chunks about to be yielded.
   * @returns the same chunks, unchanged.
   */
  #metered(
    model: string,
    free: boolean,
    servedModel: string | undefined,
    pricing: CallPricing,
    chunks: readonly StreamChunk[],
  ): readonly StreamChunk[] {
    const meter = this.#options.meter
    if (meter !== undefined) {
      for (const chunk of chunks) {
        if (chunk.type === 'usage') meter.record(model, chunk.usage, free, servedModel, pricing)
      }
    }
    return chunks
  }

  /**
   * The model's declared capacity, or undefined when the catalog cannot say.
   *
   * A catalog failure must not break a request that would otherwise work, so
   * this only ever weakens the classification above.
   */
  async #declaredContextWindow(model: string, signal?: AbortSignal): Promise<number | undefined> {
    try {
      return (await this.#options.catalog.resolve(model, signal)).context?.contextWindow
    } catch {
      return undefined
    }
  }

  /**
   * Reject a model this route is known not to serve, before any request goes
   * out.
   *
   * A typo would otherwise reach the gateway and come back as a bare `HTTP
   * 400`, which names neither the model nor the route.
   *
   * A catalog this adapter could not read is NOT treated as "model unknown":
   * the check exists to catch a demonstrably wrong id, and refusing a request
   * because our own listing was unavailable would turn a transient gateway
   * blip into an outage.
   */
  async #assertServable(model: string, signal?: AbortSignal): Promise<void> {
    let known: readonly LlmModelInfo[]
    try {
      known = await this.#options.catalog.list(signal)
    } catch (error) {
      // A caller that cancelled during the catalog read is cancelled, not
      // unverifiable. Swallowing it here would leave the abort to be noticed
      // one step later, which is a thing to rely on rather than a thing to
      // read.
      if (signal?.aborted === true) throw asLlmError(error)
      return
    }
    if (known.length === 0 || known.some(entry => entry.id === model)) return
    // Thrown here rather than delegated to the catalog: this is the
    // pre-dispatch check, and raising its own error keeps the failure code
    // fixed at UNKNOWN_MODEL regardless of which path the harness happened to
    // reach first. Delegating made the code vary.
    throw new LlmError(
      `BlockRun does not serve model "${model}" on provider route "${this.#options.provider}".`
      + suggestionSuffix(model, known.map(entry => entry.id)),
      'UNKNOWN_MODEL',
    )
  }
}

/**
 * The model this request should actually use.
 *
 * The harness tags its own maintenance calls with `purpose` and otherwise
 * reuses whatever model the conversation is on. Compaction is the expensive
 * one: it sends the WHOLE conversation, so a long session being summarized by
 * a flagship model pays flagship input rates to do a job a cheap model does
 * well. It also shares no prefix with the conversation, so moving it costs no
 * prompt-cache hit.
 *
 * A conversation request is never redirected — only calls the harness itself
 * marked as maintenance, and only when a deployment named a model for them.
 * @param options - the request, whose `purpose` marks a maintenance call.
 * @param connection - the resolved connection carrying any auxiliary model.
 * @returns the model id to send.
 */
export function auxiliaryModelFor(
  options: Pick<GenerateOptions, 'model' | 'purpose'>,
  connection: Pick<BlockrunConnection, 'auxiliaryModel'>,
): string {
  if (options.purpose === undefined) return options.model
  const auxiliary = connection.auxiliaryModel
  return auxiliary !== undefined && auxiliary.length > 0 ? auxiliary : options.model
}

/**
 * The "did you mean" tail of an unknown-model diagnostic.
 *
 * With seventy slash-prefixed ids a wrong name is almost always a near miss —
 * a dropped `vendor/` prefix, a missing hyphen — so the useful answer is the
 * name they meant, not the fact that they were wrong.
 * @param model - the id that was not found.
 * @param known - every id this route serves.
 * @returns a sentence to append, or an empty string when nothing is close.
 */
function suggestionSuffix(model: string, known: readonly string[]): string {
  const suggestions = suggestModels(model, known)
  return suggestions.length > 0 ? ` Did you mean ${suggestions.map(id => `"${id}"`).join(', ')}?` : ''
}

/** Raise the caller's abort as the harness's terminal abort, before any chunk is emitted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  throw new LlmError('BlockRun request aborted by caller', 'ABORTED', { cause: signal.reason })
}

/**
 * Map an HTTP status to a stable harness error code.
 *
 * The code decides retry behaviour: the harness retries `RATE_LIMIT`,
 * `SERVER`, `TIMEOUT`, and `TRANSPORT`, and fails fast on everything else.
 * Reporting a payment or auth failure as a transport blip would retry a
 * request that cannot succeed until a human funds a wallet or fixes a key.
 * @param status - status of a non-2xx gateway response.
 * @returns the normalized harness error code.
 */
/**
 * Chars per token, matching `dsh-token-meter`'s own fixed heuristic. Used only
 * to size a request that already failed, never to price or gate one.
 */
const CHARS_PER_TOKEN = 4


/**
 * The provider wording a failure carries, for the detectors above.
 *
 * `@blockrun/llm` puts only `"<prefix>: HTTP <status>"` in `message` and keeps
 * the decoded body on `response`, so matching the message alone would never
 * see the text that identifies an overflow or an exhausted quota.
 */
function failureDetail(error: unknown): string {
  const parts: string[] = []
  if (error instanceof Error && error.message.length > 0) parts.push(error.message)
  const response = (error as { response?: unknown })?.response
  if (response !== undefined) {
    try {
      parts.push(typeof response === 'string' ? response : JSON.stringify(response))
    } catch {
      // A body that will not serialize still leaves the message above to match
      // on; there is nothing further to recover from it.
    }
  }
  return parts.join(' ')
}

/**
 * Normalize an SDK or transport failure into a stable harness error code.
 *
 * `@blockrun/llm` reports HTTP status as `statusCode`; `status` is accepted
 * too so an error from any other layer still carries its status through.
 */
/**
 * What a `PAYMENT_REQUIRED` failure should tell the reader to do about it.
 *
 * The two cases need opposite advice, and getting it wrong wastes real money:
 * a `wallet` request is short of funds at a known address, while a `free-tier`
 * request was paying from {@link freeTierKey}'s throwaway key — so naming that
 * address would invite the reader to send USDC to a key this process discards
 * on exit.
 */
type PaymentContext =
  | { kind: 'wallet'; chain: 'Base' | 'Solana'; address?: string }
  | { kind: 'free-tier'; model: string }
  /** Account billing: the account is out of prepaid credit, and no address takes a top-up. */
  | { kind: 'api-key' }

/**
 * The two SDK clients this route drives, in the one shape it uses them.
 *
 * Structural rather than a union of the concrete classes, because the only
 * thing this adapter needs from either is `stream` — and stating that is what
 * makes it obvious that adding a chain is adding a signer, not a code path.
 * `getWalletAddress` differs in more than name: `SolanaLLMClient` derives its
 * address from an ed25519 key, which is async.
 */
interface StreamingClient {
  stream: <T>(path: string, body?: Record<string, unknown>) => AsyncIterable<T>
  getWalletAddress: () => string | Promise<string>
}

/**
 * What a failure on THIS request should say about money, if it turns out to be
 * about money.
 *
 * Built before the failure is classified, because the facts it needs are the
 * request's, not the error's — and one of them cannot be asked for twice:
 * `getWalletAddress()` throws under an account key, since account billing
 * derives no address at all. Calling it from inside the catch, as this once
 * did, replaced a payment failure the reader could act on with a `requireWallet`
 * TypeError from the SDK.
 * @param auth - the credential this request used.
 * @param client - the SDK client, asked for its address only when it has one.
 * @param free - whether the catalog billed this model at zero.
 * @param model - the model that was requested.
 * @returns the advice context for {@link fundingAdvice}.
 */
async function paymentContext(
  auth: BlockrunAuth,
  client: StreamingClient,
  free: boolean,
  model: string,
): Promise<PaymentContext> {
  if (auth.mode === 'api-key') return { kind: 'api-key' }
  if (free) return { kind: 'free-tier', model }
  const chain = auth.mode === 'solana-wallet' ? 'Solana' : 'Base'
  try {
    return { kind: 'wallet', chain, address: await client.getWalletAddress() }
  } catch {
    // Deriving a Solana address loads an optional peer dependency, so it can
    // fail for a reason that has nothing to do with the payment. The advice is
    // worth less without the address and worthless if it throws over it.
    return { kind: 'wallet', chain }
  }
}

/**
 * The published per-million rates for one model, when the catalog states any.
 *
 * Spread into a {@link CallPricing}, so a model the sheet does not price
 * produces `{ kind: 'per-token' }` with no rates — which the meter counts as
 * unpriced rather than as free.
 * @param catalog - the route's catalog, read from its last successful listing.
 * @param model - the model that was requested.
 * @returns `{ rates }`, or nothing at all.
 */
function ratesFor(catalog: BlockrunCatalog, model: string): { rates?: ModelRates } {
  const rates = catalog.rates.get(model)
  return rates === undefined ? {} : { rates }
}

/** The sentence a payment failure appends, or nothing when it is not one. */
function fundingAdvice(context: PaymentContext | undefined): string {
  if (context === undefined) return ''
  // A payment failure is the one case where the reader needs a fact only this
  // process holds. They configured a private key; the thing to send USDC to is
  // the address derived from it, which they have no way to work out from the
  // variable they set.
  if (context.kind === 'api-key') {
    // There is no address to fund: an account is prepaid, and the only way to
    // add credit is the portal. Naming a chain here would send someone to
    // move USDC that this request cannot spend.
    return ` The account is out of credit — top it up at ${PORTAL_URL}/dashboard/credits, then retry.`
  }
  if (context.kind === 'wallet') {
    // Without the address there is still one fact worth stating: WHICH chain
    // is short. Base USDC sent to a Solana address is gone, so a reader left
    // to guess between two configured wallets can lose the money by guessing
    // wrong — which is worse than the silence this used to return.
    return context.address === undefined
      ? ` The ${context.chain} wallet is short of funds; this route could not derive its address to tell you where to send more.`
      : ` Send USDC on ${context.chain} to ${context.address}, then retry.`
  }
  // The catalog said this model was free and the gateway then asked to be
  // paid, so the catalog is stale — the free tier turns over fast enough for
  // that to be the ordinary explanation rather than a corner case. Nothing the
  // reader can send money to helps until a real wallet key is configured.
  return ` "${context.model}" is listed as a free model, so this request carried no wallet.`
    + ' The gateway asked to be paid, which means it has been repriced since the catalog was read.'
    + ' Configure a funded wallet key (walletKeyEnv) to keep using it.'
}

function asLlmError(error: unknown, oversized = false, payment?: PaymentContext): LlmError {
  if (error instanceof LlmError) return error
  const message = error instanceof Error ? error.message : String(error)
  const raw = (error as { statusCode?: unknown; status?: unknown })
  const candidate = typeof raw?.statusCode === 'number' ? raw.statusCode : raw?.status
  const status = typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599
    ? candidate
    : undefined
  // A payment the SDK rejected before any request carries no status of its own.
  const paymentRejected = error instanceof Error && error.name === 'PaymentError'
  const detail = failureDetail(error)
  const mapped = status !== undefined
    ? httpErrorCode(status, detail)
    : paymentRejected ? 'PAYMENT_REQUIRED' : 'TRANSPORT'
  // The text detectors get first say, so this stays correct the moment the
  // gateway stops sanitizing upstream errors away.
  const code = mapped === 'INVALID_REQUEST' && oversized ? CONTEXT_WINDOW_EXCEEDED_CODE : mapped
  const funding = code === 'PAYMENT_REQUIRED' ? fundingAdvice(payment) : ''
  return new LlmError(`BlockRun request failed: ${message}${funding}`, code, {
    cause: error,
    ...status === undefined ? {} : { status },
  })
}

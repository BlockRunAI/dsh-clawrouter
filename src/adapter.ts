/**
 * The BlockRun `LlmAdapter`: one harness provider route whose authentication is
 * a wallet signature rather than an API key.
 *
 * Every request is paid per call in USDC over x402 — the gateway answers an
 * unpaid request with `402`, the client signs an EIP-3009 authorization
 * locally, and the retry carries it. That handshake is why this route cannot be
 * expressed as a static-credential gateway row: no header value exists ahead of
 * the request.
 *
 * @module dsh-clawrouter/adapter
 */

import { BlockrunClient } from '@blockrun/llm'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { BlockrunCatalog, toModelInfo } from './catalog.ts'
import { buildRequestBody } from './serialize.ts'
import { StreamTranslator } from './translate.ts'
import type { BlockrunStreamChunk } from './types.ts'

/** Path under the API root that serves OpenAI-compatible streaming chat. */
const CHAT_PATH = '/v1/chat/completions'

/** Everything one request needs, resolved before any network call. */
export interface BlockrunConnection {
  /** API root, e.g. `https://blockrun.ai/api`. */
  apiUrl: string
  /** Per-request SDK timeout in milliseconds. */
  timeoutMs: number
}

/** Constructor dependencies, kept explicit so the adapter owns no lifecycle. */
export interface BlockrunAdapterOptions {
  /** Harness route key this adapter is registered under. */
  provider: string
  /** Reads the current connection; called once per operation, never cached. */
  connection: () => BlockrunConnection
  /** Resolves the wallet key, or throws `LlmError('MISSING_CREDENTIAL')`. */
  resolveWalletKey: () => Promise<string>
  /** Model catalog for this route. */
  catalog: BlockrunCatalog
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
   * Stream one model response.
   * @param options - the harness request.
   * @returns harness chunks in protocol order.
   * @throws LlmError for credential, transport, and protocol failures.
   */
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.reasoningEffort !== undefined) {
      // Reasoning levels are not yet mapped onto this gateway's per-model
      // dialects. Refusing names the gap; silently dropping it would return a
      // non-reasoning answer to a request that asked for one.
      throw new LlmError(
        `dsh-clawrouter does not yet map reasoning effort "${options.reasoningEffort}" onto BlockRun`,
        'UNSUPPORTED',
      )
    }
    // Credential first: it is a local check, and a deployment with no wallet
    // has a more fundamental problem than whichever model it named.
    const privateKey = await this.#options.resolveWalletKey()
    await this.#assertServable(options.model, options.signal)
    const connection = this.#options.connection()
    const body = buildRequestBody(options)

    const client = new BlockrunClient({
      privateKey,
      apiUrl: connection.apiUrl,
      timeout: connection.timeoutMs,
    })

    const translator = new StreamTranslator()
    const iterator = client.stream<BlockrunStreamChunk>(CHAT_PATH, body)[Symbol.asyncIterator]()
    try {
      for (;;) {
        throwIfAborted(options.signal)
        let next: IteratorResult<BlockrunStreamChunk>
        try {
          next = await iterator.next()
        } catch (error) {
          throw asLlmError(error)
        }
        if (next.done === true) break
        // Checked again after the await: a turn cancelled while this read was
        // outstanding must not emit the chunk it was waiting on.
        throwIfAborted(options.signal)
        yield * translator.accept(next.value)
      }
      yield * translator.end()
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
    throw new LlmError(
      `BlockRun does not serve model "${model}"; call listModels() for the current catalog`,
      'UNKNOWN_MODEL',
    )
  }
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
export function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  // x402's own status. Retrying cannot help: the wallet is short, or the
  // signed authorization was refused.
  if (status === 402) return 'PAYMENT_REQUIRED'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * Normalize an SDK or transport failure into a stable harness error code.
 *
 * `@blockrun/llm` reports HTTP status as `statusCode`; `status` is accepted
 * too so an error from any other layer still carries its status through.
 */
function asLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  const message = error instanceof Error ? error.message : String(error)
  const raw = (error as { statusCode?: unknown; status?: unknown })
  const candidate = typeof raw?.statusCode === 'number' ? raw.statusCode : raw?.status
  const status = typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599
    ? candidate
    : undefined
  // A payment the SDK rejected before any request carries no status of its own.
  const paymentRejected = error instanceof Error && error.name === 'PaymentError'
  const code = status !== undefined
    ? httpErrorCode(status)
    : paymentRejected ? 'PAYMENT_REQUIRED' : 'TRANSPORT'
  return new LlmError(`BlockRun request failed: ${message}`, code, {
    cause: error,
    ...status === undefined ? {} : { status },
  })
}

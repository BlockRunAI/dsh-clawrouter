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
    // Resolved before the first byte so a missing wallet fails naming the
    // credential rather than surfacing as an opaque SDK constructor throw.
    const privateKey = await this.#options.resolveWalletKey()
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
}

/** Raise the caller's abort as the harness's terminal abort, before any chunk is emitted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  throw new LlmError('BlockRun request aborted by caller', 'ABORTED', { cause: signal.reason })
}

/** Normalize an SDK or transport failure into a stable harness error code. */
function asLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  const message = error instanceof Error ? error.message : String(error)
  const status = (error as { status?: unknown })?.status
  const code = typeof status === 'number' && status === 402 ? 'PAYMENT_REQUIRED' : 'TRANSPORT'
  return new LlmError(`BlockRun request failed: ${message}`, code, {
    cause: error,
    ...typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {},
  })
}

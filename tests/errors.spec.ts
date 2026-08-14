import { describe, expect, it } from 'vitest'
import { auxiliaryModelFor, httpErrorCode, looksOversized } from '../src/adapter.ts'

// The harness retries exactly these and fails fast on everything else
// (dsh-llm's DEFAULT_RETRYABLE_CODES).
const RETRYABLE = new Set(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])

describe('httpErrorCode', () => {
  it.each([
    [401, 'AUTH'],
    [403, 'AUTH'],
    [402, 'PAYMENT_REQUIRED'],
    [429, 'RATE_LIMIT'],
    [400, 'INVALID_REQUEST'],
    [500, 'SERVER'],
    [502, 'SERVER'],
    [503, 'SERVER'],
  ])('maps %i to %s', (status, code) => {
    expect(httpErrorCode(status)).toBe(code)
  })

  it('keeps an unmapped status visible rather than flattening it', () => {
    expect(httpErrorCode(418)).toBe('HTTP_418')
  })

  it('does not make a payment failure retryable', () => {
    // The regression this file exists for: every failure used to normalize to
    // TRANSPORT, which IS retryable — so an insufficient-funds 402 was retried
    // twice against a wallet that could not pay, and a 401 was retried instead
    // of failing fast. Retrying cannot fund a wallet or fix a key.
    expect(RETRYABLE.has(httpErrorCode(402))).toBe(false)
    expect(RETRYABLE.has(httpErrorCode(401))).toBe(false)
    expect(RETRYABLE.has(httpErrorCode(400))).toBe(false)
  })

  it('keeps genuinely transient failures retryable', () => {
    expect(RETRYABLE.has(httpErrorCode(429))).toBe(true)
    expect(RETRYABLE.has(httpErrorCode(500))).toBe(true)
  })

  it.each([
    'This model\'s maximum context length is 128000 tokens',
    'prompt is too long for this model',
  ])('maps an overflow 400 to CONTEXT_WINDOW_EXCEEDED: %j', (detail) => {
    // compaction-basic compares failure.code against this exact constant to
    // decide whether to recover. Reporting an overflow as INVALID_REQUEST
    // costs a long session its automatic compaction: it just fails.
    expect(httpErrorCode(400, detail)).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('still reports an ordinary 400 as an invalid request', () => {
    expect(httpErrorCode(400, 'unknown parameter: frobnicate')).toBe('INVALID_REQUEST')
  })

  it.each([
    [429, 'insufficient quota for this account'],
    [400, 'credits exhausted'],
  ])('maps exhausted-account wording on %i to QUOTA', (status, detail) => {
    // A quota is not a rate limit: retrying a rate limit helps, retrying an
    // empty account does not. The wording match is the harness's own
    // `isQuotaExceededError`; what is asserted here is that this adapter
    // routes through it rather than flattening the case.
    expect(httpErrorCode(status, detail)).toBe('QUOTA')
    expect(RETRYABLE.has(httpErrorCode(status, detail))).toBe(false)
  })

  it('keeps 402 as a payment failure even when it says insufficient balance', () => {
    // x402's own status is the more precise answer than a generic account
    // quota: this wallet is short, and that is a different fix.
    expect(httpErrorCode(402, 'insufficient balance')).toBe('PAYMENT_REQUIRED')
  })
})

describe('auxiliaryModelFor', () => {
  it('leaves a conversation request on its own model', () => {
    // A request the harness did not mark as maintenance is the user's choice
    // of model, and is never redirected.
    expect(auxiliaryModelFor({ model: 'anthropic/claude-opus-5' }, { auxiliaryModel: 'deepseek/deepseek-chat' }))
      .toBe('anthropic/claude-opus-5')
  })

  it.each(['compaction', 'session-title'] as const)('moves a %s call to the auxiliary model', (purpose) => {
    expect(auxiliaryModelFor({ model: 'anthropic/claude-opus-5', purpose }, { auxiliaryModel: 'deepseek/deepseek-chat' }))
      .toBe('deepseek/deepseek-chat')
  })

  it('keeps maintenance calls on the conversation model when none is configured', () => {
    // Off by default: this is the harness's own behaviour, and a deployment
    // opts out of it explicitly rather than being surprised by a swap.
    expect(auxiliaryModelFor({ model: 'anthropic/claude-opus-5', purpose: 'compaction' }, {}))
      .toBe('anthropic/claude-opus-5')
    expect(auxiliaryModelFor({ model: 'anthropic/claude-opus-5', purpose: 'compaction' }, { auxiliaryModel: '' }))
      .toBe('anthropic/claude-opus-5')
  })
})

describe('looksOversized — the only overflow signal this gateway leaves', () => {
  it('recognises a request larger than the model can hold', () => {
    // Measured against the live gateway: gpt-4o rejected a 140K-token prompt
    // with body {"message":"API request failed"} — every word the text
    // detectors look for had been sanitized away.
    expect(looksOversized(128_000 * 4 + 1, 128_000)).toBe(true)
  })

  it('leaves an ordinary request alone', () => {
    expect(looksOversized(4_000, 128_000)).toBe(false)
    expect(looksOversized(128_000 * 4, 128_000)).toBe(false)
  })

  it('says nothing when the capacity is unknown', () => {
    // A catalog that could not answer must weaken the classification, never
    // invent one.
    expect(looksOversized(10_000_000, undefined)).toBe(false)
    expect(looksOversized(10_000_000, 0)).toBe(false)
  })
})

describe('the sanitized 400 the gateway really returns', () => {
  const SANITIZED = JSON.stringify({ message: 'API request failed' })

  it('is not recognised by the text detectors, which is why size matters', () => {
    // Documents the reason the size heuristic exists. If this ever starts
    // returning CONTEXT_WINDOW_EXCEEDED, the gateway stopped sanitizing and
    // the heuristic has become a backstop rather than the only signal.
    expect(httpErrorCode(400, SANITIZED)).toBe('INVALID_REQUEST')
  })

  it('still classifies by text first when the wording survives', () => {
    expect(httpErrorCode(400, 'maximum context length is 128000 tokens')).toBe('CONTEXT_WINDOW_EXCEEDED')
  })
})

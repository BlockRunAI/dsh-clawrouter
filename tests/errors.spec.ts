import { describe, expect, it } from 'vitest'
import { httpErrorCode } from '../src/adapter.ts'

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
})

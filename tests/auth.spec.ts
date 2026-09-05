// The credential plane, checked where it is decided rather than where it fails.
//
// Two credentials reach the same models through two hosts, and every mistake
// worth catching here is a mismatch between them: a key sent to the host that
// answers it 402, a catalog read anonymously against a host that answers 401,
// or a wallet quietly paying for a call the reader put on an account.
import { describe, expect, it } from 'vitest'
import {
  API_KEY_PATTERN,
  catalogEndpoint,
  DEFAULT_API_KEY_URL,
  DEFAULT_SOLANA_API_URL,
  freeTierKey,
  PORTAL_URL,
  requestFeeFor,
  SOLANA_WALLET_KEY_PATTERN,
  WALLET_KEY_PATTERN,
} from '../src/auth.ts'

describe('the two credentials are told apart by shape', () => {
  it('accepts the account keys BlockRun actually issues', () => {
    expect(API_KEY_PATTERN.test('brk_live_H4OzmQQDX09FElTg06Gv3Wh7i6C5jIozzVH0QBW5')).toBe(true)
    expect(API_KEY_PATTERN.test('brk_test_abc-DEF_123')).toBe(true)
  })

  it('rejects a wallet key pasted into the API-key reference, which is the real mistake', () => {
    // Both are secrets that look like noise, and the variables sit next to
    // each other in a shell profile. Caught here, it names the reference; sent
    // on, it is an opaque 401 from a host the reader did not know was involved.
    expect(API_KEY_PATTERN.test(`0x${'a'.repeat(64)}`)).toBe(false)
    expect(WALLET_KEY_PATTERN.test('brk_live_abc')).toBe(false)
  })

  it('rejects an OpenAI key, which is the other thing people paste', () => {
    expect(API_KEY_PATTERN.test('sk-proj-abcdef')).toBe(false)
  })

  it('takes an EVM key only in the form the signer can use', () => {
    expect(WALLET_KEY_PATTERN.test(`0x${'A1'.repeat(32)}`)).toBe(true)
    expect(WALLET_KEY_PATTERN.test(`0x${'a'.repeat(63)}`)).toBe(false)
    expect(WALLET_KEY_PATTERN.test('a'.repeat(64))).toBe(false)
  })
})

describe('a catalog read goes to the host the credential is valid against', () => {
  it('carries the bearer token on the account host, which answers 401 without it', () => {
    const endpoint = catalogEndpoint({ mode: 'api-key', apiKey: 'brk_live_x', apiUrl: DEFAULT_API_KEY_URL })
    expect(endpoint.baseURL).toBe('https://api.blockrun.ai/v1')
    expect(endpoint.headers).toEqual({ authorization: 'Bearer brk_live_x' })
  })

  it('sends no credential to the wallet gateway, whose catalog is public', () => {
    const endpoint = catalogEndpoint({ mode: 'wallet', privateKey: `0x${'a'.repeat(64)}`, apiUrl: 'https://blockrun.ai/api' })
    expect(endpoint.baseURL).toBe('https://blockrun.ai/api/v1')
    expect(endpoint.headers).toBeUndefined()
  })

  it('never doubles the slash on a base that already ends in one', () => {
    expect(catalogEndpoint({ mode: 'wallet', privateKey: '0x1', apiUrl: 'https://blockrun.ai/api/' }).baseURL)
      .toBe('https://blockrun.ai/api/v1')
  })
})

describe('the free-tier stand-in key', () => {
  it('is a usable EVM key, so the SDK constructor accepts it', () => {
    expect(WALLET_KEY_PATTERN.test(freeTierKey())).toBe(true)
  })

  it('is generated once per process, because it signs nothing', () => {
    expect(freeTierKey()).toBe(freeTierKey())
  })
})

describe('the portal is named once', () => {
  it('is where an account, a key, and credit all come from', () => {
    // Asserted because three diagnostics interpolate it, and a reader sent to
    // the wrong host has no way to tell it is the wrong host.
    expect(PORTAL_URL).toBe('https://user.blockrun.ai')
  })
})

describe('Solana is told apart from Base by the key itself', () => {
  // The two wallet variables sit next to each other in a shell profile and
  // both hold something that looks like noise. The failure worth catching is
  // an EVM key in the Solana reference: it is a valid secret of the wrong
  // kind, so nothing downstream rejects it until a payment call is already
  // under way.
  const BS58 = '5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviQeRjpzKCY8trDwpvBMTKTpNFbCJsBZthJ4tCs6o62rr'

  it('accepts the three encodings @blockrun/llm decodes', () => {
    expect(SOLANA_WALLET_KEY_PATTERN.test(BS58)).toBe(true)
    expect(SOLANA_WALLET_KEY_PATTERN.test('a'.repeat(128))).toBe(true)
    expect(SOLANA_WALLET_KEY_PATTERN.test(`0x${'a'.repeat(128)}`)).toBe(true)
    expect(SOLANA_WALLET_KEY_PATTERN.test('[1,2,3,4]')).toBe(true)
  })

  it('rejects an EVM key, which is 64 hex and not 128', () => {
    expect(SOLANA_WALLET_KEY_PATTERN.test(`0x${'a'.repeat(64)}`)).toBe(false)
    expect(WALLET_KEY_PATTERN.test(BS58)).toBe(false)
  })

  it('rejects an account key in the wallet reference', () => {
    expect(SOLANA_WALLET_KEY_PATTERN.test('brk_live_abc')).toBe(false)
  })
})

describe('the per-request quote is a property of the chain', () => {
  // Measured 2026-09-05 on the same deepseek/deepseek-chat request: Base
  // answered {"amount":"2000"} and Solana {"amount":"1000"}, both µUSDC. The
  // meter multiplies this by the call count, so one figure for both chains is
  // a total that is double or half on one of them.
  it('quotes Solana and Base separately', () => {
    expect(requestFeeFor({ mode: 'solana-wallet', privateKey: 'x', apiUrl: DEFAULT_SOLANA_API_URL }))
      .toBe(0.001)
    expect(requestFeeFor({ mode: 'wallet', privateKey: 'x', apiUrl: 'https://blockrun.ai/api' }))
      .toBe(0.002)
  })

  it('quotes nothing at all for an account key, which is billed per token', () => {
    expect(requestFeeFor({ mode: 'api-key', apiKey: 'brk_live_x', apiUrl: DEFAULT_API_KEY_URL }))
      .toBeUndefined()
  })

  it("takes a deployment's own figures over the measured defaults", () => {
    expect(
      requestFeeFor(
        { mode: 'solana-wallet', privateKey: 'x', apiUrl: DEFAULT_SOLANA_API_URL },
        { base: 0.5, solana: 0.25 },
      ),
    ).toBe(0.25)
  })
})

describe('a Solana catalog read is anonymous, like the other wallet gateway', () => {
  it('derives the /v1 base from the Solana host and sends no credential', () => {
    const endpoint = catalogEndpoint({
      mode: 'solana-wallet',
      privateKey: 'x',
      apiUrl: DEFAULT_SOLANA_API_URL,
    })
    expect(endpoint.baseURL).toBe('https://sol.blockrun.ai/api/v1')
    expect(endpoint.headers).toBeUndefined()
  })
})

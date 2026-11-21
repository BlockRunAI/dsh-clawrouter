// The credential plane, checked where it is decided rather than where it fails.
//
// Two credentials reach the same models through two hosts, and every mistake
// worth catching here is a mismatch between them: a key sent to the host that
// answers it 402, a catalog read anonymously against a host that answers 401,
// or a wallet quietly paying for a call the reader put on an account.
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  API_KEY_PATTERN,
  catalogEndpoint,
  checkApiKey,
  clearSavedApiKeys,
  DEFAULT_API_KEY_FILES,
  fetchLedgerSummary,
  saveApiKey,
  fetchCreditBalance,
  formatCreditBalance,
  maskApiKey,
  readSavedApiKey,
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

describe('a saved account key is read the way ClawRouter reads it', () => {
  const KEY = `brk_live_${'K'.repeat(40)}`
  const scratch = (): Promise<string> => mkdtemp(join(tmpdir(), 'dsh-clawrouter-auth-'))

  it('looks where `clawrouter login` writes, then at the older location', () => {
    expect(DEFAULT_API_KEY_FILES).toEqual(['~/.blockrun/.api-key', '~/.openclaw/blockrun/api-key'])
  })

  it('is undefined when no file exists, which is the normal state on a wallet deployment', async () => {
    const dir = await scratch()
    expect(await readSavedApiKey([join(dir, 'a'), join(dir, 'b')])).toBeUndefined()
  })

  it('takes the first file that holds a key and says which one', async () => {
    const dir = await scratch()
    await writeFile(join(dir, 'second'), `${KEY}\n`)
    expect(await readSavedApiKey([join(dir, 'first'), join(dir, 'second')]))
      .toEqual({ key: KEY, path: join(dir, 'second') })
  })

  it('expands ~ against the home of whoever is running', async () => {
    const home = await scratch()
    await mkdir(join(home, '.blockrun'))
    await writeFile(join(home, '.blockrun', '.api-key'), KEY)
    const before = process.env['HOME']
    process.env['HOME'] = home
    try {
      expect(await readSavedApiKey()).toEqual({ key: KEY, path: '~/.blockrun/.api-key' })
    } finally {
      process.env['HOME'] = before
    }
  })

  it('treats an empty file as absent', async () => {
    const dir = await scratch()
    await writeFile(join(dir, 'empty'), '  \n')
    await writeFile(join(dir, 'real'), KEY)
    expect((await readSavedApiKey([join(dir, 'empty'), join(dir, 'real')]))?.key).toBe(KEY)
  })

  it('refuses a file that holds something else, naming the file and not its content', async () => {
    const dir = await scratch()
    const secret = `0x${'a'.repeat(64)}`
    await writeFile(join(dir, 'wrong'), secret)
    await writeFile(join(dir, 'real'), KEY)
    // Skipping it would reach the next file — a different account's key.
    const failure = await readSavedApiKey([join(dir, 'wrong'), join(dir, 'real')]).catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain(join(dir, 'wrong'))
    expect((failure as Error).message).not.toContain(secret)
  })

  it('refuses a file that exists but cannot be read', async () => {
    const dir = await scratch()
    // A directory where the file should be: present, and not ENOENT.
    await mkdir(join(dir, 'key'))
    await expect(readSavedApiKey([join(dir, 'key')])).rejects.toThrow(/Cannot read the BlockRun API key file/)
  })

  it('masks a key to the head the portal shows and four trailing characters', () => {
    expect(maskApiKey('brk_live_Ab3xQ9zzzzzzzzzzzzzzzzf8c1')).toBe('brk_live_Ab3xQ…f8c1')
    expect(maskApiKey('brk_short')).toBe('brk_shor…')
  })
})

describe('the account credit line', () => {
  it('reads remaining and spent', () => {
    expect(formatCreditBalance({ spentUsd: 8.8, remainingUsd: 41.2, blocked: false }))
      .toBe('$41.20 remaining (spent $8.80)')
  })

  it('does not call an ungated account broke', () => {
    // remaining_usd is null there by design; "$0.00 remaining" would be a lie.
    expect(formatCreditBalance({ billingMode: 'ungated', spentUsd: 3.5, remainingUsd: null, blocked: false }))
      .toBe('spent $3.50 — no prepaid limit')
  })

  it('says so when the account is blocked', () => {
    expect(formatCreditBalance({ spentUsd: 5, remainingUsd: 0, blocked: true, blockedReason: 'credit exhausted' }))
      .toBe('$0.00 remaining (spent $5.00) — BLOCKED: credit exhausted')
  })

  it('answers undefined, never an error, when the host cannot be reached', async () => {
    expect(await fetchCreditBalance('http://127.0.0.1:1', 'brk_live_x', 500)).toBeUndefined()
  })
})

describe('saving and removing a key', () => {
  const KEY = `brk_live_${'W'.repeat(40)}`
  const scratch = (): Promise<string> => mkdtemp(join(tmpdir(), 'dsh-clawrouter-save-'))

  it('creates the directory and writes the key readable by its owner only', async () => {
    const path = join(await scratch(), 'a', 'b', '.api-key')
    await saveApiKey(`  ${KEY}  `, path)
    expect(await readFile(path, 'utf8')).toBe(`${KEY}\n`)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readSavedApiKey([path])).toEqual({ key: KEY, path })
  })

  it('writes nothing for something that is not a key', async () => {
    const path = join(await scratch(), '.api-key')
    await expect(saveApiKey('sk-not-ours', path)).rejects.toThrow(/Not a BlockRun API key/)
    await expect(stat(path)).rejects.toThrow()
  })

  it('removes every saved copy, not just the first', async () => {
    const dir = await scratch()
    const [first, second, missing] = [join(dir, 'one'), join(dir, 'two'), join(dir, 'three')]
    await writeFile(first, KEY)
    await writeFile(second, KEY)
    // A key left in the older location would be used on the very next call.
    expect(await clearSavedApiKeys([first, missing, second])).toEqual([first, second])
    expect(await readSavedApiKey([first, second])).toBeUndefined()
  })
})

describe('an unreachable account host says nothing about a key', () => {
  it('is `unknown`, not `rejected`', async () => {
    expect(await checkApiKey('http://127.0.0.1:1', 'brk_live_x', 500)).toEqual({ verdict: 'unknown' })
  })

  it('gives no ledger figure rather than a zero one', async () => {
    expect(await fetchLedgerSummary('http://127.0.0.1:1', 'brk_live_x', new Date(), 500)).toBeUndefined()
  })
})

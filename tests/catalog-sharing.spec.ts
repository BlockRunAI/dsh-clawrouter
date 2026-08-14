// Regression coverage for the shared catalog read. One fetch answers every
// concurrent caller, which is only safe if no single caller can poison it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockrunCatalog, CATALOG_TTL_MS } from '../src/catalog.ts'

const BODY = { data: [{ id: 'deepseek/deepseek-chat', name: 'V4 Flash', categories: ['chat'], context_window: 1000 }] }

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(BODY), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BlockrunCatalog request sharing', () => {
  it('serves concurrent callers from a single request', async () => {
    const catalog = new BlockrunCatalog('blockrun', 'https://example.test/v1')
    const [a, b, c] = await Promise.all([catalog.list(), catalog.list(), catalog.list()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('does not let one caller cancelling break another caller', async () => {
    const catalog = new BlockrunCatalog('blockrun', 'https://example.test/v1')
    const quitter = new AbortController()

    const abandoned = catalog.list(quitter.signal)
    const patient = catalog.list()
    quitter.abort()

    // The regression: the shared fetch used to carry whichever signal arrived
    // first, so this abort failed every other caller waiting on the same read.
    await expect(abandoned).rejects.toThrow(/aborted/i)
    await expect(patient).resolves.toHaveLength(1)
  })

  it('gives a cancelling caller its cancellation, not a stale catalog', async () => {
    const clock = { now: Date.now() }
    const catalog = new BlockrunCatalog('blockrun', 'https://example.test/v1', () => clock.now)
    await catalog.list()

    // Expire the cache so the next call must refresh, and hang the refresh so
    // the caller is still waiting when it cancels.
    clock.now += CATALOG_TTL_MS + 1
    fetchMock.mockImplementation(() => new Promise(() => {}))

    const controller = new AbortController()
    const pending = catalog.list(controller.signal)
    controller.abort()
    // A cached catalog exists, so the fallback below would happily return it.
    // Returning it here would dress a cancellation up as a fresh read.
    await expect(pending).rejects.toThrow(/aborted/i)
  })

  it('serves the last good catalog when a later refresh fails', async () => {
    const clock = { now: Date.now() }
    const catalog = new BlockrunCatalog('blockrun', 'https://example.test/v1', () => clock.now)
    expect(await catalog.list()).toHaveLength(1)

    clock.now += CATALOG_TTL_MS + 1
    fetchMock.mockRejectedValue(new Error('gateway down'))
    // A selector that listed models a minute ago must not empty because one
    // refresh failed.
    expect(await catalog.list()).toHaveLength(1)
  })

  it('surfaces the failure when nothing has ever been cached', async () => {
    fetchMock.mockRejectedValue(new Error('gateway down'))
    const catalog = new BlockrunCatalog('blockrun', 'https://example.test/v1')
    await expect(catalog.list()).rejects.toThrow(/catalog request failed/i)
  })

  it('reuses a cached catalog without refetching', async () => {
    const catalog = new BlockrunCatalog('blockrun', 'https://example.test/v1')
    await catalog.list()
    await catalog.list()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refetches once the cache expires', async () => {
    const clock = { now: Date.now() }
    const catalog = new BlockrunCatalog('blockrun', 'https://example.test/v1', () => clock.now)
    await catalog.list()
    clock.now += CATALOG_TTL_MS + 1
    await catalog.list()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('bounds the shared request with its own deadline', async () => {
    const catalog = new BlockrunCatalog('blockrun', 'https://example.test/v1')
    await catalog.list()
    // A shared promise with no deadline would park every later caller behind a
    // hung gateway, so the request must carry a signal of its own.
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })
})

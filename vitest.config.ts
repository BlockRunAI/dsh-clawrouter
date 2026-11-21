import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * The unit suite. Its one job beyond the defaults is to keep the developer's
 * own saved BlockRun key out of the tests: since 0.13.0 the route reads
 * `~/.blockrun/.api-key`, so on a machine that has run `clawrouter login` a
 * test asserting "no credential" would find a real one — and a test that then
 * made a request would bill a real account. Pointing HOME at a directory that
 * does not exist makes every run start from the same nothing.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    env: { HOME: join(tmpdir(), 'dsh-clawrouter-no-such-home') },
  },
})

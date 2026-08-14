import { defineConfig } from 'vitest/config'

/**
 * Live-gateway tests, kept out of the default `vitest run` on purpose: they
 * spend real USDC. Run them deliberately with `npm run test:e2e`; they
 * self-skip when no wallet is available.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.e2e.ts'],
    // One request at a time: these are real paid calls, and a burst adds
    // nothing but concurrent settlements to reason about when one fails.
    fileParallelism: false,
    testTimeout: 180_000,
  },
})

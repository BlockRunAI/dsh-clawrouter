import { defineConfig } from 'tsup'

/**
 * Self-contained build. `prepare` runs this after a git install, where no
 * sibling checkout, project reference, or type-check context exists — so this
 * config transpiles `src/` alone and never depends on the workspace it was
 * authored in.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/review.ts'],
  format: ['esm'],
  outDir: 'lib',
  target: 'node22',
  dts: { entry: ['src/index.ts', 'src/review.ts'] },
  clean: true,
  sourcemap: false,
  // Harness packages are peers supplied by the dsh installation; bundling a
  // second copy would give this plugin its own cordis instance.
  external: [/^@deepseek-ai\//, /^@blockrun\//],
})

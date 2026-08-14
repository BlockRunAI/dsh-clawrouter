// Rewrites every `<!-- br:models.chatVisible -->N<!-- /br:models.chatVisible -->`
// marker in the READMEs from the live gateway catalog.
//
// The markers were introduced without this script, so eight of them sat at 70
// while the catalog moved to 67 — a number that looks generated and is not is
// worse than a plain one, because nobody re-checks it.
//
// Counts through `projectCatalog`, so the figure is what this route actually
// exposes rather than what the gateway happens to list.
import { readFileSync, writeFileSync } from 'node:fs'
import { projectCatalog } from '../src/catalog.ts'
import { DEFAULT_API_URL } from '../src/index.ts'

const response = await fetch(`${DEFAULT_API_URL}/v1/models`)
if (!response.ok) throw new Error(`catalog request failed: ${response.status}`)
const count = projectCatalog('blockrun', await response.json()).length
if (count === 0) throw new Error('catalog returned no usable models; refusing to write 0')

const MARKER = /(<!-- br:models\.chatVisible -->)\d+(<!-- \/br:models\.chatVisible -->)/g
for (const path of ['README.md', 'docs/README.zh.md']) {
  const before = readFileSync(path, 'utf8')
  const after = before.replace(MARKER, `$1${count}$2`)
  const sites = [...before.matchAll(MARKER)].length
  if (after !== before) writeFileSync(path, after)
  console.log(`${path}: ${sites} marker(s) -> ${count}${after === before ? ' (unchanged)' : ''}`)
}

// package.json carries the same count in the description npm renders on the
// package page, where HTML comment markers cannot go. It was missed when the
// markers were first filled, so npm showed 70 while every README said 67 — the
// generator has to own every site or it just moves the stale copy somewhere
// less visible.
const PACKAGE_COUNT = /(plus )\d+( models from one wallet)/
const manifestPath = 'package.json'
const manifest = readFileSync(manifestPath, 'utf8')
if (!PACKAGE_COUNT.test(manifest)) throw new Error(`${manifestPath} description no longer matches ${PACKAGE_COUNT}`)
const updated = manifest.replace(PACKAGE_COUNT, `$1${count}$2`)
if (updated !== manifest) writeFileSync(manifestPath, updated)
console.log(`${manifestPath}: description -> ${count}${updated === manifest ? ' (unchanged)' : ''}`)

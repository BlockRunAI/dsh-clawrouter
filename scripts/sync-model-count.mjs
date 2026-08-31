// Rewrites every generated model-count marker in the READMEs from the live
// gateway catalog: `<!-- br:models.chatVisible -->N<!-- /... -->` for the
// models this route can converse with, and `<!-- br:models.free -->N<!-- /... -->`
// for the subset the gateway serves without payment.
//
// The markers were introduced without this script, so eight of them sat at 70
// while the catalog moved to 67 — a number that looks generated and is not is
// worse than a plain one, because nobody re-checks it.
//
// Counts through `projectCatalog`, so the figure is what this route actually
// exposes rather than what the gateway happens to list.
import { readFileSync, writeFileSync } from 'node:fs'
import { projectCatalog, projectFreeModels } from '../src/catalog.ts'
import { DEFAULT_API_URL } from '../src/index.ts'

const response = await fetch(`${DEFAULT_API_URL}/v1/models`)
if (!response.ok) throw new Error(`catalog request failed: ${response.status}`)
const body = await response.json()
const models = projectCatalog('blockrun', body)
const count = models.length

// The free tier needs generating even more than the total does: it turns over
// far faster. On 2026-08-30 NVIDIA retired four of the five free models in a
// single sweep and three replacements landed the same day, so a hand-written
// "seven free models" is a sentence with a shelf life measured in days.
//
// Counted against the chat models above rather than the whole response, so it
// is the number of free models THIS route can converse with — the free tier
// also carries entries this route would never send a chat request to.
const free = projectFreeModels(body)
const freeCount = models.filter(model => free.has(model.id)).length

const marker = name => new RegExp(`(<!-- br:models\\.${name} -->)\\d+(<!-- \\/br:models\\.${name} -->)`, 'g')
const COUNTS = [
  // A zero free tier is a real state, not a bug to refuse: four of the five
  // free models died in one morning, and all seven could. A zero total is
  // always a failed read, so that one still refuses rather than publishing a
  // route that serves nothing.
  { name: 'free', value: freeCount, floor: 0 },
  { name: 'chatVisible', value: count, floor: 1 },
]
for (const { name, value, floor } of COUNTS) {
  if (value < floor) throw new Error(`catalog reports ${value} ${name} models; refusing to write it`)
}

for (const path of ['README.md', 'docs/README.zh.md']) {
  let before = readFileSync(path, 'utf8')
  const original = before
  for (const { name, value } of COUNTS) {
    const pattern = marker(name)
    const sites = [...before.matchAll(pattern)].length
    before = before.replace(pattern, `$1${value}$2`)
    console.log(`${path}: ${sites} ${name} marker(s) -> ${value}`)
  }
  if (before !== original) writeFileSync(path, before)
  else console.log(`${path}: unchanged`)
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

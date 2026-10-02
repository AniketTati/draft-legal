#!/usr/bin/env node
/**
 * check-bundle-size.mjs — per-chunk gzip budget gate for the web bundle.
 *
 * Referenced by `pnpm build:check` and the CI `bundle-size` job, but the file
 * was never committed (like the fictional feature-integrity probes Wave 0
 * removed) — so `build:check` and CI failed at "Cannot find module". Recreated
 * in Wave 4 as a real gate.
 *
 * The web app was code-split into editor / pdf / charts / tanstack / icons /
 * index chunks so first paint doesn't ship one monolithic bundle. This gate
 * gzips each built chunk and fails the build if any named chunk — or the total
 * initial JS — exceeds its budget, so a careless import can't silently balloon
 * the bundle without a PR-level conversation.
 *
 * Budgets are set with ~20% headroom over the sizes at authoring time; bumping
 * one is a deliberate, reviewable act (edit the number below with justification).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'assets')

// Per-chunk gzip budgets, in kB. Keyed by the chunk's logical name (the part of
// the filename before the content hash). A file matches a key if it starts with
// `<key>-`. Unknown JS chunks are allowed but still count toward TOTAL_JS_KB.
const CHUNK_BUDGETS_KB = {
  // App entry. Pages load on first visit (App.tsx), which took it from 532 kB to
  // 150 kB; the cap holds that gain with some room.
  index:    200,
  pdf:      290,
  editor:   190,
  charts:   145,
  tanstack:  30,
  icons:     25,
}
// Ceiling on total gzipped JS shipped from dist/assets. Raised from 1080 when
// pages became their own chunks: each chunk gzips alone and shared code repeats
// across some, so the sum grew ~60 kB while what a first visit downloads fell
// by ~380 kB. No one downloads every page.
const TOTAL_JS_KB = 1150

function gzipKb(path) {
  return gzipSync(readFileSync(path)).length / 1024
}

if (!existsSync(DIST)) {
  console.error(`[bundle-size] dist/assets not found at ${DIST} — run \`pnpm build\` first.`)
  process.exit(1)
}

const jsFiles = readdirSync(DIST).filter(f => f.endsWith('.js'))
if (jsFiles.length === 0) {
  console.error('[bundle-size] no .js chunks found in dist/assets — build output looks wrong.')
  process.exit(1)
}

const failures = []
let totalJs = 0
const rows = []

for (const file of jsFiles) {
  const kb = gzipKb(join(DIST, file))
  totalJs += kb
  const key = Object.keys(CHUNK_BUDGETS_KB).find(k => file.startsWith(`${k}-`))
  const budget = key ? CHUNK_BUDGETS_KB[key] : null
  rows.push({ file, kb, key: key ?? '(unbudgeted)', budget })
  if (budget != null && kb > budget) {
    failures.push(`chunk "${key}" (${file}) is ${kb.toFixed(1)} kB gzip, over its ${budget} kB budget`)
  }
}

if (totalJs > TOTAL_JS_KB) {
  failures.push(`total JS is ${totalJs.toFixed(1)} kB gzip, over the ${TOTAL_JS_KB} kB budget`)
}

// Report
rows.sort((a, b) => b.kb - a.kb)
console.log('[bundle-size] gzipped JS chunks:')
for (const r of rows) {
  const cap = r.budget != null ? `/ ${r.budget} kB` : '(no per-chunk cap)'
  const flag = r.budget != null && r.kb > r.budget ? '  ✗ OVER' : ''
  console.log(`  ${r.kb.toFixed(1).padStart(7)} kB ${cap.padEnd(18)} ${r.key.padEnd(14)} ${r.file}${flag}`)
}
console.log(`[bundle-size] total JS: ${totalJs.toFixed(1)} kB gzip / ${TOTAL_JS_KB} kB budget`)

if (failures.length > 0) {
  console.error('\n[bundle-size] FAILED:')
  for (const f of failures) console.error(`  ✗ ${f}`)
  console.error('\nCode-split the offending chunk (dynamic import / manualChunks), or bump the budget in scripts/check-bundle-size.mjs with justification.')
  process.exit(1)
}

console.log('[bundle-size] OK — all chunks within budget.')

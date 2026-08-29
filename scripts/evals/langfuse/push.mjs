#!/usr/bin/env node
/**
 * Push the JSON case files in ./datasets into Langfuse as datasets + items.
 *
 * Idempotent: item ids come from the case file, and Langfuse upserts on id, so
 * re-running edits in place instead of duplicating the corpus. That is the
 * property that lets a case keep its score history across an edit — a corpus
 * that loses its identity on every push cannot show you a regression.
 *
 * Usage:
 *   node scripts/evals/langfuse/push.mjs                 # all case files
 *   node scripts/evals/langfuse/push.mjs harness         # one, by file stem
 *   node scripts/evals/langfuse/push.mjs --dry-run       # validate, send nothing
 *
 * Case-file format is JSON rather than the YAML docs/37 ADR-01 anticipated:
 * the workspace has no YAML parser and adding a dependency to read three files
 * is a poor trade, while JSON is the dataset API's own wire format and needs
 * no parser at all. The promptfoo off-ramp the ADR was protecting reads JSON
 * too, so nothing is foreclosed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDataset, upsertItem, configured, LANGFUSE_HOST } from './lf.mjs'
import { SCORER_NAMES } from './scorers.mjs'
import { TARGETS } from './targets.mjs'

const DIR = fileURLToPath(new URL('./datasets', import.meta.url))
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const only = args.filter((a) => !a.startsWith('--'))

function loadFiles() {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))
  const picked = only.length ? files.filter((f) => only.includes(path.basename(f, '.json'))) : files
  if (!picked.length) {
    throw new Error(`no case files matched ${only.join(', ')} — available: ${files.map((f) => path.basename(f, '.json')).join(', ')}`)
  }
  return picked.map((f) => ({ file: f, spec: JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }))
}

/**
 * Validate before sending. A case naming a scorer or target that does not
 * exist would otherwise push cleanly and then fail mid-run, after the model
 * spend — the expensive place to discover a typo.
 */
function validate(spec, file) {
  const errs = []
  if (!spec.dataset) errs.push('missing "dataset"')
  const seen = new Set()
  for (const item of spec.items ?? []) {
    const where = `${file}:${item.id ?? '<no id>'}`
    if (!item.id) errs.push(`${where}: item has no id`)
    if (seen.has(item.id)) errs.push(`${where}: duplicate id`)
    seen.add(item.id)
    if (!item.target) errs.push(`${where}: no target`)
    else if (!TARGETS[item.target]) errs.push(`${where}: unknown target "${item.target}" (known: ${Object.keys(TARGETS).join(', ')})`)
    for (const s of item.scorers ?? []) {
      const kind = String(s).split(':')[0]
      const known = SCORER_NAMES.some((n) => n === s || n.split(':')[0] === kind)
      if (!known) errs.push(`${where}: unknown scorer "${s}"`)
    }
    if (!item.scorers?.length) errs.push(`${where}: no scorers — a case with no assertions always passes (docs/37 E4)`)
  }
  return errs
}

const specs = loadFiles()
const allErrs = specs.flatMap(({ file, spec }) => validate(spec, file))
if (allErrs.length) {
  console.error('✗ case files are invalid:\n' + allErrs.map((e) => `   ${e}`).join('\n'))
  process.exit(1)
}
console.log(`✓ validated ${specs.length} case file(s), ${specs.reduce((n, s) => n + s.spec.items.length, 0)} items`)

if (dryRun) {
  for (const { spec } of specs) console.log(`   [dry-run] ${spec.dataset}: ${spec.items.length} items`)
  process.exit(0)
}

if (!configured()) {
  console.error('✗ Langfuse is not configured. Set LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY (docs/operations/LANGFUSE.md).')
  process.exit(1)
}

let pushed = 0
for (const { spec } of specs) {
  await ensureDataset(spec.dataset, spec.description, spec.metadata)
  for (const item of spec.items) {
    await upsertItem({
      datasetName: spec.dataset,
      id: item.id,
      input: item.input,
      expectedOutput: item.expectedOutput,
      // The scorers and target travel WITH the item, so a run driven straight
      // from Langfuse (rather than from these files) still knows how to
      // execute and grade the case.
      metadata: { ...item.metadata, target: item.target, scorers: item.scorers },
    })
    pushed++
  }
  console.log(`   → ${spec.dataset}: ${spec.items.length} items`)
}
console.log(`✓ pushed ${pushed} items to ${LANGFUSE_HOST}`)

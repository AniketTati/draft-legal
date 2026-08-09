#!/usr/bin/env node
/**
 * check-design-system.mjs — conformance gate for the draftLegal Design System.
 *
 * The design system's whole premise is that color carries meaning: ink acts,
 * emerald means binding, indigo means a machine wrote it. That premise survives
 * exactly as long as nobody reaches for `bg-blue-600` again. A one-time
 * migration cannot hold it; a check that runs on every build can.
 *
 * Three rules, in descending order of how badly breaking them hurts:
 *
 *   1. No raw Tailwind hue classes, and no raw hex, in app source. The palette
 *      in tailwind.config.ts (paper/ink/brand/assist/info/attention/risk) covers
 *      every case, so a raw hue is always a value that escaped meaning.
 *   2. Indigo/assist only on machine-authored surfaces. This is the rule the
 *      design system states most emphatically ("Delete every indigo-* literal
 *      outside agent components") because the mark stops meaning "the model
 *      wrote this" the moment a button borrows it.
 *   3. No off-scale elevation. Borders before shadows; e3 is overlays only.
 *
 * Run: node scripts/check-design-system.mjs   (also wired into `pnpm lint:ds`)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SRC = new URL('../src/', import.meta.url).pathname

// Raw Tailwind hues. The whole point of the palette is that none of these are
// ever the right answer inside this app.
const HUES =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|' +
  'teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
const UTILS =
  'bg|text|border|ring|from|to|via|fill|stroke|decoration|divide|placeholder|' +
  'shadow|outline|accent|caret|shadow'

const RAW_HUE = new RegExp(`\\b(?:${UTILS})-(?:${HUES})-[0-9]{2,3}\\b`, 'g')
// Hex inside a className/style string. Bare hex in a comment is fine.
const RAW_HEX = /(?:className|class|style)\s*=\s*[{"'`][^"'`}]*#[0-9a-fA-F]{3,8}\b/g
// Tailwind's stock elevation scale — replaced by e0–e3 + shadow-page.
const OFF_SCALE_SHADOW = /\bshadow-(?:sm|md|lg|xl|2xl|inner)\b/g

/*
 * Opacity modifiers OUTSIDE Tailwind's default scale.
 *
 * This one is here because it already bit us. `ring-brand-700/12` looks
 * perfectly reasonable and is what the design system's spec literally says
 * (rgba(4,120,87,0.12)) — but 12 is not a step in Tailwind v3's opacity scale,
 * so the utility is not emitted at all. It fails SILENTLY: no build warning, no
 * type error, the class just isn't in the stylesheet. Fifty-seven of them
 * shipped across thirty-three files, which meant every focused text field in
 * the product fell back to Tailwind's stock BLUE focus halo — the one colour
 * the design system reserves for "in flight".
 *
 * Nothing else in the toolchain catches this, so it is caught here.
 */
const OPACITY_SCALE = new Set([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100])
const OPACITY_MOD = new RegExp(`\\b(?:${UTILS})-[a-z]+(?:-\\d{2,3})?/(\\d{1,3})\\b`, 'g')

/**
 * Surfaces allowed to speak in assist indigo. Everything the model authors
 * lives here; nothing else may borrow the accent.
 */
const ASSIST_ALLOWED = [
  'components/agent/',
  'components/ui/assist.tsx',
  'components/ui/button.tsx', // where the assist / assistOutline variants are defined
  'components/contracts/BubbleAiPopover.tsx',
  'components/contracts/ClauseDeviationPopover.tsx',
  'components/contracts/DefinedTermsRailSection.tsx',
  'components/contracts/PlaybookRedlineRailSection.tsx',
  'components/contracts/RedlinePanel.tsx',
  'components/contracts/RenewalAdviceRailSection.tsx',
  'components/editor/',
  'pages/AgentHomePage.tsx',
  'pages/ReviewQueuePage.tsx',
  // The rest of the machine-authored surfaces outside components/agent. Each
  // one shows model output or is an "Ask draftLegal" affordance, which the
  // design system names as assist territory alongside the agent components:
  'components/contracts/CoachMarks.tsx',          // the assistant introducing itself
  'components/contracts/DecisionStrip.tsx',       // the AI confidence reading
  'components/contracts/DocumentCanvas.tsx',      // "Ask about this selection"
  'components/contracts/FocusedReviewDrawer.tsx', // model-drafted alternative language
  'pages/ContractDetailPage.tsx',                 // AI analysis panel + extracted terms
  'pages/InvoicesPage.tsx',                       // what the invoice matcher concluded
  'components/layout/Sidebar.tsx',                // the /agent entry point at rest
]
const ASSIST_USE = /\b(?:bg|text|border|ring|from|to|via|fill|stroke|decoration|divide|placeholder)-assist(?:-[0-9]{2,3})?\b/g

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx|ts|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

const violations = []
function record(file, line, rule, text) {
  violations.push({ file, line, rule, text: text.trim().slice(0, 110) })
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length
}

for (const abs of walk(SRC)) {
  const file = relative(SRC, abs).split(sep).join('/')
  const src = readFileSync(abs, 'utf8')

  for (const m of src.matchAll(RAW_HUE)) {
    record(file, lineOf(src, m.index), 'raw-hue', m[0])
  }
  for (const m of src.matchAll(RAW_HEX)) {
    record(file, lineOf(src, m.index), 'raw-hex', m[0])
  }
  for (const m of src.matchAll(OFF_SCALE_SHADOW)) {
    record(file, lineOf(src, m.index), 'off-scale-shadow', m[0])
  }
  for (const m of src.matchAll(OPACITY_MOD)) {
    if (!OPACITY_SCALE.has(Number(m[1]))) {
      record(file, lineOf(src, m.index), 'dead-opacity-modifier', m[0])
    }
  }
  if (!ASSIST_ALLOWED.some((p) => file.startsWith(p) || file === p)) {
    for (const m of src.matchAll(ASSIST_USE)) {
      record(file, lineOf(src, m.index), 'assist-outside-agent', m[0])
    }
  }
}

if (violations.length === 0) {
  console.log('✓ design system: no violations')
  process.exit(0)
}

const byRule = violations.reduce((acc, v) => {
  ;(acc[v.rule] ||= []).push(v)
  return acc
}, {})

const EXPLAIN = {
  'raw-hue': 'Use the palette: paper/ink (neutrals), brand (binding), info (in flight), attention (your turn), risk, assist (machine).',
  'raw-hex': 'Hex in markup escapes the token layer. Use a palette class or hsl(var(--token)).',
  'off-scale-shadow': 'Elevation is e0–e3 (+ shadow-page). Borders before shadows; e3 is overlays only.',
  'assist-outside-agent': 'Indigo means "a machine wrote this". Outside agent surfaces it stops meaning anything.',
  'dead-opacity-modifier': 'Not a step in Tailwind\'s opacity scale, so this utility is never emitted — it fails silently. Use the nearest multiple of 5.',
}

console.error(`\n✗ design system: ${violations.length} violation(s)\n`)
for (const [rule, list] of Object.entries(byRule)) {
  console.error(`  ${rule} — ${list.length}`)
  console.error(`  ${EXPLAIN[rule]}`)
  for (const v of list.slice(0, 12)) {
    console.error(`    ${v.file}:${v.line}  ${v.text}`)
  }
  if (list.length > 12) console.error(`    … and ${list.length - 12} more`)
  console.error('')
}
process.exit(1)

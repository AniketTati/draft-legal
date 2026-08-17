#!/usr/bin/env node
/**
 * verify.mjs — prove the picture matches the voice, beat by beat.
 *
 * For every beat it pulls the frame from the middle of that beat's narration
 * and writes it as out/verify/beat-NN-M.png, next to the line being spoken over
 * it. Open the folder and read down: each image should already show the thing
 * its caption talks about. Anything that arrives late is visible immediately.
 *
 *   node scripts/demo-video/verify.mjs
 *   node scripts/demo-video/verify.mjs --at 0.2      # sample nearer the line's start
 *
 * Writes out/verify/index.md as the contact sheet.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { REPO_ROOT } from '../lib/repo-root.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? d : argv[i + 1]
}

const OUT = path.resolve(flag('out', path.join(__dirname, 'out')))
const VIDEO = path.resolve(flag('video', path.join(OUT, 'draftlegal-demo.mp4')))
// Where inside the line to sample. 0.45 is deliberate: far enough in that any
// transition has finished, early enough that the NEXT beat's action has not
// started, so the frame is unambiguous about which line it belongs to.
const AT = Number(flag('at', '0.45'))
const VERIFY_DIR = path.join(OUT, 'verify')

const timelinePath = path.join(OUT, 'timeline.json')
if (!fs.existsSync(timelinePath)) {
  console.error(`✖ no timeline.json in ${OUT} — run record.mjs first`)
  process.exit(1)
}
if (!fs.existsSync(VIDEO)) {
  console.error(`✖ no video at ${VIDEO}`)
  process.exit(1)
}

const timeline = JSON.parse(fs.readFileSync(timelinePath, 'utf8'))
const beats = timeline.beats ?? []
if (!beats.length) {
  console.error('✖ timeline.json has no beats — re-record with the current record.mjs')
  process.exit(1)
}

fs.rmSync(VERIFY_DIR, { recursive: true, force: true })
fs.mkdirSync(VERIFY_DIR, { recursive: true })

const videoDur = parseFloat(
  execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', VIDEO],
    { encoding: 'utf8' }
  ).trim()
)

const rows = []
for (const b of beats) {
  const at = (b.audioStartMs + b.durationMs * AT) / 1000
  if (at > videoDur) {
    console.warn(`  ⚠ ${b.id} samples at ${at.toFixed(1)}s, past the ${videoDur.toFixed(1)}s video`)
    continue
  }
  const png = path.join(VERIFY_DIR, `${b.id}.png`)
  execFileSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-ss', at.toFixed(3), '-i', VIDEO, '-frames:v', '1', '-q:v', '2', png],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  rows.push({ ...b, at })
  console.log(`  ✓ ${b.id}  @ ${at.toFixed(1).padStart(6)}s  “${b.text.slice(0, 60)}${b.text.length > 60 ? '…' : ''}”`)
}

const md = [
  '# Sync check',
  '',
  `Frame sampled ${Math.round(AT * 100)}% of the way through each line.`,
  'Each image should **already show** what its line describes.',
  '',
  '| Beat | At | Line being spoken | Frame |',
  '|------|-----|-------------------|-------|',
  ...rows.map(
    (r) => `| \`${r.id}\`${r.overlap ? ' *(overlap)*' : ''} | ${r.at.toFixed(1)}s | ${r.text.replace(/\|/g, '\\|')} | ![${r.id}](./${r.id}.png) |`
  ),
  '',
]
fs.writeFileSync(path.join(VERIFY_DIR, 'index.md'), md.join('\n'))

console.log(`\n✓ ${rows.length} frames → ${path.relative(REPO_ROOT, VERIFY_DIR)}`)
console.log(`✓ ${path.relative(REPO_ROOT, path.join(VERIFY_DIR, 'index.md'))}`)

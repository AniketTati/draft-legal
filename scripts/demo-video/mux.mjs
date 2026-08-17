#!/usr/bin/env node
/**
 * mux.mjs — lay the narration onto the recording.
 *
 * Each scene's audio is placed at the offset where that scene actually starts
 * in the video, read from timeline.json. That is what makes the sync robust:
 * if a scene runs long (a slow model call, a slow page), its narration still
 * begins exactly when the scene does, and the gap lands as a beat of silence
 * rather than dragging every later line out of position.
 *
 *   node scripts/demo-video/mux.mjs
 *   node scripts/demo-video/mux.mjs --music bed.mp3 --music-gain 0.06
 *
 * Output: scripts/demo-video/out/draftlegal-demo-vo.mp4
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
const VO_DIR = flag('vo') ? path.resolve(flag('vo')) : path.join(REPO_ROOT, 'docs/demo-video/vo')
const BEAT_DIR = path.join(VO_DIR, 'beats')
const VIDEO = path.resolve(flag('video', path.join(OUT, 'draftlegal-demo.mp4')))
const MUSIC = flag('music') ? path.resolve(flag('music')) : null
const MUSIC_GAIN = Number(flag('music-gain', '0.07'))
const FINAL = path.join(OUT, 'draftlegal-demo-vo.mp4')

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
const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.ogg']

// One track per BEAT, each pinned to the moment its visual was already settled
// on screen. Per-scene anchoring drifted inside long scenes; per-beat does not.
const units = timeline.beats ?? timeline.scenes ?? []
const tracks = []
const missing = []
for (const u of units) {
  const stem = u.id ?? u.vo
  const dir = u.id ? BEAT_DIR : VO_DIR
  const found = AUDIO_EXT.map((e) => path.join(dir, stem + e)).find((f) => fs.existsSync(f))
  if (!found) {
    missing.push(stem)
    continue
  }
  tracks.push({
    file: found,
    startMs: u.audioStartMs ?? u.startMs,
    label: stem,
    text: u.text ?? '',
  })
}

if (!tracks.length) {
  console.error(
    `✖ no beat audio found in ${BEAT_DIR}\n` +
      `  Generate it with: node scripts/demo-video/tts.mjs`
  )
  process.exit(1)
}
if (missing.length) {
  console.warn(`⚠ no audio for: ${missing.join(', ')} — those scenes will play silent`)
}

// One input per scene, each delayed to its own start offset, then summed.
// amix would duck each track as others start, so amerge/volume is wrong here
// too — adelay + amix with normalize=0 keeps every line at full level.
const inputs = ['-i', VIDEO]
for (const t of tracks) inputs.push('-i', t.file)
if (MUSIC) inputs.push('-stream_loop', '-1', '-i', MUSIC)

const parts = tracks.map(
  (t, i) => `[${i + 1}:a]adelay=${Math.round(t.startMs)}|${Math.round(t.startMs)},volume=1.0[v${i}]`
)
let mixIns = tracks.map((_, i) => `[v${i}]`).join('')
let mixCount = tracks.length

if (MUSIC) {
  const musicIdx = tracks.length + 1
  parts.push(`[${musicIdx}:a]volume=${MUSIC_GAIN}[bed]`)
  mixIns += '[bed]'
  mixCount += 1
}

parts.push(`${mixIns}amix=inputs=${mixCount}:normalize=0:dropout_transition=0[aout]`)

const args = [
  '-y',
  ...inputs,
  '-filter_complex', parts.join(';'),
  '-map', '0:v',
  '-map', '[aout]',
  '-c:v', 'copy',
  '-c:a', 'aac',
  '-b:a', '192k',
  '-shortest',
  '-movflags', '+faststart',
  FINAL,
]

console.log(`→ muxing ${tracks.length} narration track(s)${MUSIC ? ' + music bed' : ''}`)
execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] })

console.log(`\n✓ ${path.relative(REPO_ROOT, FINAL)}`)
for (const t of tracks) {
  const preview = t.text.slice(0, 44) + (t.text.length > 44 ? '…' : '')
  console.log(`  ${t.label}  @ ${(t.startMs / 1000).toFixed(1).padStart(6)}s  “${preview}”`)
}

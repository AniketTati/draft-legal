#!/usr/bin/env node
/**
 * tts.mjs — turn the scene scripts into narration audio with Gemini TTS.
 *
 * Reads every docs/demo-video/vo/scene-NN-*.txt and writes scene-NN-*.mp3 beside
 * it, which is exactly where record.mjs and mux.mjs look for them.
 *
 *   node scripts/demo-video/tts.mjs --sample        # audition voices on one line
 *   node scripts/demo-video/tts.mjs                 # generate all ten scenes
 *   node scripts/demo-video/tts.mjs --voice Kore --scenes 2,6
 *
 * The key comes from GOOGLE_API_KEY (or GEMINI_API_KEY) in the environment or
 * the repo-root .env, and is sent as a header — never in a URL, never printed.
 *
 * Gemini returns raw 16-bit PCM at 24 kHz, so this wraps it in a WAV header and
 * hands it to ffmpeg. Cloud Text-to-Speech (texttospeech.googleapis.com) is the
 * other option and takes SSML, but it is not enabled on this project's key.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { REPO_ROOT } from '../lib/repo-root.mjs'
import { SCENES, allBeats } from './beats.js'

const argv = process.argv.slice(2)
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? d : argv[i + 1]
}
const has = (n) => argv.includes(`--${n}`)

// ── key ─────────────────────────────────────────────────────────────────────
function apiKey() {
  const fromEnv = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY
  if (fromEnv) return fromEnv
  const envFile = path.join(REPO_ROOT, '.env')
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*(GOOGLE_API_KEY|GEMINI_API_KEY)\s*=\s*(.+?)\s*$/)
      if (m && m[2]) return m[2].replace(/^["']|["']$/g, '')
    }
  }
  console.error(
    '✖ no GOOGLE_API_KEY or GEMINI_API_KEY found in the environment or .env'
  )
  process.exit(1)
}
const KEY = apiKey()

// ── options ─────────────────────────────────────────────────────────────────
const VO_DIR = flag('vo') ? path.resolve(flag('vo')) : path.join(REPO_ROOT, 'docs/demo-video/vo')
const MODEL = flag('model', 'gemini-2.5-pro-preview-tts')
const VOICE = flag('voice', 'Charon')
const ONLY = flag('scenes') ? flag('scenes').split(',').map((s) => s.trim()) : null
const ONLY_BEATS = flag('beats') ? flag('beats').split(',').map((s) => s.trim()) : null
const KEEP_WAV = has('wav')
const FORCE = has('force')

// NO style prefix by default, and this is deliberate.
//
// Prefixing the text with delivery notes is the documented pattern, but it is
// not reliable: the model sometimes READS the note instead of obeying it. It
// did exactly that on beat-01-2, which shipped in a cut saying "calm,
// confident, and clear, at a measured pace..." in place of its actual line.
// Duration arithmetic did not catch it because the instruction ran about as
// long as the line it replaced.
//
// The voices are well-behaved without direction, so the default is now to send
// the line and nothing else — there is no instruction available to leak. If you
// do want direction, --style sends it as a systemInstruction, which is the
// right channel for it, and check-audio.mjs will tell you if it leaks anyway.
const STYLE = flag('style', '')

const SAMPLE_VOICES = (flag('voices', 'Charon,Kore,Algieba,Iapetus') || '').split(',')
const SAMPLE_TEXT = flag(
  'text',
  'Every legal team runs on the same two problems. The contracts are somewhere. ' +
    'And nobody can answer a question about them without opening twenty of them. ' +
    'Draft Legal fixes both.'
)

// ── synthesis ───────────────────────────────────────────────────────────────
/** Wrap raw little-endian 16-bit mono PCM in a RIFF/WAVE header. */
function pcmToWav(pcm, sampleRate = 24_000) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // PCM chunk size
  header.writeUInt16LE(1, 20) // format = PCM
  header.writeUInt16LE(1, 22) // channels
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate (1ch × 16bit)
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function synthesize(text, voice, attempt = 1) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        ...(STYLE ? { systemInstruction: { parts: [{ text: STYLE }] } } : {}),
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    }
  )

  if (!res.ok) {
    const body = await res.text()
    // 429 / 503 are worth waiting out; anything else is a real problem.
    if ((res.status === 429 || res.status >= 500) && attempt <= 4) {
      const wait = 2000 * attempt
      console.warn(`  ⚠ HTTP ${res.status} — retrying in ${wait / 1000}s`)
      await sleep(wait)
      return synthesize(text, voice, attempt + 1)
    }
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`)
  }

  const data = await res.json()
  const part = data?.candidates?.[0]?.content?.parts?.[0]
  const inline = part?.inlineData ?? part?.inline_data
  if (!inline?.data) {
    const finish = data?.candidates?.[0]?.finishReason ?? 'unknown'
    throw new Error(`no audio in response (finishReason: ${finish})`)
  }
  const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? '')?.[1] ?? 24_000)
  return pcmToWav(Buffer.from(inline.data, 'base64'), rate)
}

function toMp3(wavPath, mp3Path) {
  execFileSync(
    'ffmpeg',
    ['-y', '-i', wavPath, '-codec:a', 'libmp3lame', '-b:a', '192k', '-ar', '44100', mp3Path],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
}

const durationOf = (f) =>
  parseFloat(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f],
      { encoding: 'utf8' }
    ).trim()
  )

// ── run ─────────────────────────────────────────────────────────────────────
// Keep the human-readable script in step with the beats that actually get
// spoken. These .txt files are OUTPUTS — beats.js is the source of truth.
function writeScriptFiles() {
  fs.mkdirSync(VO_DIR, { recursive: true })
  const paragraphs = []
  for (const scene of SCENES) {
    const text = scene.beats.map((b) => b.text.trim()).join(' ')
    const file = `scene-${String(scene.id).padStart(2, '0')}-${scene.slug}.txt`
    fs.writeFileSync(path.join(VO_DIR, file), text + '\n')
    paragraphs.push(text)
  }
  fs.writeFileSync(path.join(VO_DIR, 'full-narration.txt'), paragraphs.join('\n\n') + '\n')
}

if (has('sample')) {
  const outDir = path.join(VO_DIR, 'samples')
  fs.mkdirSync(outDir, { recursive: true })
  console.log(`→ auditioning ${SAMPLE_VOICES.length} voices on ${MODEL}\n`)
  for (const voice of SAMPLE_VOICES) {
    const wav = path.join(outDir, `sample-${voice}.wav`)
    const mp3 = path.join(outDir, `sample-${voice}.mp3`)
    try {
      fs.writeFileSync(wav, await synthesize(SAMPLE_TEXT, voice))
      toMp3(wav, mp3)
      if (!KEEP_WAV) fs.rmSync(wav, { force: true })
      console.log(`  ✓ ${voice.padEnd(10)} ${durationOf(mp3).toFixed(1)}s  ${path.relative(REPO_ROOT, mp3)}`)
    } catch (e) {
      console.error(`  ✖ ${voice.padEnd(10)} ${e.message}`)
    }
    await sleep(600)
  }
  console.log(`\nListen, then generate with:  node scripts/demo-video/tts.mjs --voice <name>`)
  process.exit(0)
}

writeScriptFiles()

const BEAT_DIR = path.join(VO_DIR, 'beats')
fs.mkdirSync(BEAT_DIR, { recursive: true })

const beats = allBeats()
  .filter((b) => !ONLY || ONLY.includes(String(b.scene)))
  .filter((b) => !ONLY_BEATS || ONLY_BEATS.includes(b.id))
console.log(`→ ${MODEL} · voice ${VOICE} · ${beats.length} beat(s)\n`)

let total = 0
let lastScene = null
const failures = []

for (const beat of beats) {
  if (beat.scene !== lastScene) {
    console.log(`  scene ${beat.scene}`)
    lastScene = beat.scene
  }
  const mp3 = path.join(BEAT_DIR, `${beat.id}.mp3`)
  const preview = beat.text.slice(0, 46) + (beat.text.length > 46 ? '…' : '')

  if (fs.existsSync(mp3) && !FORCE) {
    const d = durationOf(mp3)
    total += d
    console.log(`    · ${beat.id}  ${d.toFixed(1).padStart(5)}s  (exists)  “${preview}”`)
    continue
  }

  const wav = path.join(BEAT_DIR, `${beat.id}.wav`)
  try {
    fs.writeFileSync(wav, await synthesize(beat.text, VOICE))
    toMp3(wav, mp3)
    if (!KEEP_WAV) fs.rmSync(wav, { force: true })
    const d = durationOf(mp3)
    total += d
    const words = beat.text.split(/\s+/).length
    console.log(`    ✓ ${beat.id}  ${d.toFixed(1).padStart(5)}s  ${String(Math.round((words / d) * 60)).padStart(3)} wpm  “${preview}”`)
  } catch (e) {
    failures.push(`${beat.id}: ${e.message}`)
    console.error(`    ✖ ${beat.id}  ${e.message}`)
  }
  await sleep(800) // stay well inside the per-minute quota
}

console.log(
  `\n✓ ${total.toFixed(1)}s of narration across ${beats.length} beats ` +
    `(${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')})`
)
if (failures.length) {
  console.log(`\n${failures.length} beat(s) failed — re-run to retry just those:`)
  for (const f of failures) console.log('  · ' + f)
  process.exit(1)
}
console.log('\nNext:  node scripts/demo-video/record.mjs   then   node scripts/demo-video/mux.mjs')

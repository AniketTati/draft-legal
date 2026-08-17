#!/usr/bin/env node
/**
 * check-audio.mjs — transcribe the generated narration and diff it against the
 * script, so nothing ships that the voice engine got wrong.
 *
 * The failure this exists for: a style instruction handed to the TTS model as
 * part of the prompt can be *spoken* instead of obeyed, and duration arithmetic
 * is too blunt to catch it reliably — a short instruction on a long line hides
 * inside the noise. Reading the words back is the only check that actually
 * settles it.
 *
 * It also catches dropped sentences, and pronunciation of the product name
 * (the transcript shows what the listener will hear, not what we sent).
 *
 *   node scripts/demo-video/check-audio.mjs
 *   node scripts/demo-video/check-audio.mjs --beats beat-01-1,beat-01-2
 *
 * Exits non-zero if any clip diverges, so it can gate a take.
 */
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../lib/repo-root.mjs'
import { allBeats } from './beats.js'

const argv = process.argv.slice(2)
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? d : argv[i + 1]
}

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
  console.error('✖ no GOOGLE_API_KEY or GEMINI_API_KEY found')
  process.exit(1)
}
const KEY = apiKey()

const VO_DIR = flag('vo') ? path.resolve(flag('vo')) : path.join(REPO_ROOT, 'docs/demo-video/vo')
const BEAT_DIR = path.join(VO_DIR, 'beats')
const MODEL = flag('model', 'gemini-2.5-flash')
const ONLY = flag('beats') ? flag('beats').split(',').map((s) => s.trim()) : null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Transcribers write "$200,000" where the voice said "two hundred thousand
 *  dollars". Both are correct; only one matches the script. Spell digits back
 *  out so the diff compares what was SAID, not how it was written down. */
const ONES = ['zero','one','two','three','four','five','six','seven','eight','nine','ten',
  'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen']
const TENS = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety']

function intToWords(n) {
  if (n < 20) return ONES[n]
  if (n < 100) return (TENS[Math.floor(n / 10)] + ' ' + (n % 10 ? ONES[n % 10] : '')).trim()
  if (n < 1000) return (ONES[Math.floor(n / 100)] + ' hundred ' + (n % 100 ? intToWords(n % 100) : '')).trim()
  for (const [size, name] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) {
    if (n >= size) {
      return (intToWords(Math.floor(n / size)) + ' ' + name + ' ' +
        (n % size ? intToWords(n % size) : '')).trim()
    }
  }
  return String(n)
}

function spellNumbers(s) {
  return s
    // "$1.2M" / "26 million" style survive as-is; plain integers get spelled.
    .replace(/\$\s?([\d,]+)/g, (_, d) => intToWords(Number(d.replace(/,/g, ''))) + ' dollars')
    .replace(/\b(\d[\d,]*)\b/g, (_, d) => {
      const n = Number(d.replace(/,/g, ''))
      return Number.isFinite(n) && n < 1e12 ? intToWords(n) : d
    })
}

/** Compare on sound, not spelling: the engine cannot be blamed for punctuation. */
const norm = (s) =>
  spellNumbers(String(s))
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Longest-common-subsequence ratio over words — tolerant of small slips. */
function similarity(a, b) {
  const x = norm(a).split(' ')
  const y = norm(b).split(' ')
  const dp = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1))
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      dp[i][j] = x[i - 1] === y[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  return (2 * dp[x.length][y.length]) / (x.length + y.length)
}

// Transcripts are cached against the clip's size+mtime, so re-running after
// fixing two lines costs two API calls rather than thirty-four. The free tier's
// per-minute quota is the binding constraint here, not latency.
const CACHE_FILE = path.join(BEAT_DIR, '.transcripts.json')
const cache = fs.existsSync(CACHE_FILE)
  ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
  : {}
const cacheKey = (file) => {
  const st = fs.statSync(file)
  return `${path.basename(file)}:${st.size}:${Math.round(st.mtimeMs)}`
}
const saveCache = () => fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2))

async function transcribe(file, attempt = 1) {
  const key = cacheKey(file)
  if (cache[key]) return cache[key]
  const b64 = fs.readFileSync(file).toString('base64')
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text:
                  'Transcribe this audio verbatim. Write only the words that are actually ' +
                  'spoken, in order, with no commentary, no labels and no quotation marks. ' +
                  'If the speaker reads out what sounds like an instruction to a narrator, ' +
                  'include it — do not silently clean it up.',
              },
              { inlineData: { mimeType: 'audio/mp3', data: b64 } },
            ],
          },
        ],
        generationConfig: { temperature: 0 },
      }),
    }
  )
  if (!res.ok) {
    const body = await res.text()
    if ((res.status === 429 || res.status >= 500) && attempt <= 6) {
      // A 429 here is a per-MINUTE quota, so seconds of backoff never clears
      // it. Honour the server's own retryDelay when it sends one, else wait out
      // the window.
      const suggested = /"retryDelay"\s*:\s*"(\d+)s"/.exec(body)?.[1]
      const waitMs = suggested ? (Number(suggested) + 2) * 1000 : Math.min(65_000, 20_000 * attempt)
      console.warn(`      ⋯ HTTP ${res.status}, waiting ${Math.round(waitMs / 1000)}s`)
      await sleep(waitMs)
      return transcribe(file, attempt + 1)
    }
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 160).replace(/\s+/g, ' ')}`)
  }
  const data = await res.json()
  const text = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join(' ')
    .trim()
  cache[key] = text
  saveCache()
  return text
}

// Phrases that should never reach a listener's ears. If any appears in a
// transcript, the model read its own direction aloud rather than obeying it.
// Matched on whole-phrase word boundaries — an earlier substring match fired on
// "sure," inside "mea-SURE-d against" and condemned a perfectly good clip.
const LEAKS = [
  'read the following',
  'product demo narrator',
  'at a measured pace',
  'speak only the text',
  'natural sentence rhythm',
  'no salesy emphasis',
  'here is the text',
  'here is the audio',
  'sure here',
  'okay here',
]
const leaked = (heard) => {
  const h = ` ${norm(heard)} `
  return LEAKS.find((p) => h.includes(` ${norm(p)} `))
}

const beats = allBeats().filter((b) => !ONLY || ONLY.includes(b.id))
console.log(`→ transcribing ${beats.length} clip(s) with ${MODEL}\n`)

const problems = []
for (const beat of beats) {
  const file = path.join(BEAT_DIR, `${beat.id}.mp3`)
  if (!fs.existsSync(file)) {
    console.log(`  – ${beat.id}  (no audio)`)
    continue
  }
  let heard
  try {
    heard = await transcribe(file)
  } catch (e) {
    console.error(`  ✖ ${beat.id}  ${e.message}`)
    problems.push({ id: beat.id, kind: 'error', detail: e.message })
    continue
  }

  const leak = leaked(heard)
  const sim = similarity(beat.text, heard)

  if (leak) {
    console.error(`  ✖ ${beat.id}  SPOKEN INSTRUCTION — heard "${leak}"`)
    console.error(`      heard: ${heard.slice(0, 160)}`)
    problems.push({ id: beat.id, kind: 'leak', detail: heard })
  } else if (sim < 0.85) {
    console.error(`  ✖ ${beat.id}  diverges (${(sim * 100).toFixed(0)}% match)`)
    console.error(`      want:  ${beat.text.slice(0, 140)}`)
    console.error(`      heard: ${heard.slice(0, 140)}`)
    problems.push({ id: beat.id, kind: 'mismatch', detail: heard })
  } else {
    console.log(`  ✓ ${beat.id}  ${(sim * 100).toFixed(0)}%  “${heard.slice(0, 58)}${heard.length > 58 ? '…' : ''}”`)
  }
  await sleep(1800) // stay under the per-minute quota
}

console.log()
if (problems.length) {
  console.error(`✖ ${problems.length} clip(s) need regenerating:`)
  for (const p of problems) console.error(`  · ${p.id} (${p.kind})`)
  console.error(`\n  node scripts/demo-video/tts.mjs --force --beats ${problems.map((p) => p.id).join(',')}`)
  process.exit(1)
}
console.log('✓ every clip says exactly what the script says')

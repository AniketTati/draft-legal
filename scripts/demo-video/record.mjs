#!/usr/bin/env node
/**
 * record.mjs — drive the running app through the demo and record it.
 *
 * Sync model: the VIDEO leads and the audio follows. For each beat the action
 * runs first, the screen is allowed to settle, and only then does that beat's
 * narration start. So the thing being described is always already on screen —
 * it can never arrive after the line that describes it.
 *
 * The cost is that a slow page shows up as a short silence rather than as
 * drift, which is the right trade: silence reads as pacing, drift reads as
 * broken. Beats marked `overlap` (the agent thinking) start their audio as the
 * action begins, because the line narrates the wait itself.
 *
 *   node scripts/demo-video/record.mjs --fast --shots   # rehearse, ~60s
 *   node scripts/demo-video/record.mjs                  # the real take
 *   node scripts/demo-video/record.mjs --scenes 2,6     # just those scenes
 *
 * Output: out/draftlegal-demo.mp4 + out/timeline.json (per-beat audio offsets)
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { REPO_ROOT } from '../lib/repo-root.mjs'
import { SCENES } from './beats.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const has = (name) => argv.includes(`--${name}`)

const BASE = flag('base', 'http://localhost:5173')
const OUT = path.resolve(flag('out', path.join(__dirname, 'out')))
const VO_DIR = flag('vo') ? path.resolve(flag('vo')) : path.join(REPO_ROOT, 'docs/demo-video/vo')
const BEAT_DIR = path.join(VO_DIR, 'beats')
const CAPTIONS = has('captions')
const FAST = has('fast')
const SHOTS = has('shots')
const ONLY = flag('scenes') ? flag('scenes').split(',').map((s) => s.trim()) : null
const WPM = Number(flag('wpm', '140'))
const EMAIL = process.env.DEMO_EMAIL || 'admin@demo.com'
const PASSWORD = process.env.DEMO_PASSWORD || 'password123'

// How long to let the screen stand still after an action before its line
// starts. Long enough for the spotlight transition (450ms) to finish, so the
// first frame the viewer hears narration over is a settled one.
const SETTLE_MS = Number(flag('settle', '420'))

const W = 1920
const H = 1080
fs.mkdirSync(OUT, { recursive: true })

// ── beat timing ─────────────────────────────────────────────────────────────
const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.ogg']

function audioFor(beatId) {
  for (const ext of AUDIO_EXT) {
    const f = path.join(BEAT_DIR, beatId + ext)
    if (fs.existsSync(f)) return f
  }
  return null
}

/** Real duration of a beat's line, in ms. Measured if the audio exists. */
function beatDuration(beat) {
  const f = audioFor(beat.id)
  if (f) {
    try {
      const secs = parseFloat(
        execFileSync(
          'ffprobe',
          ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f],
          { encoding: 'utf8' }
        ).trim()
      )
      if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000)
    } catch {
      /* fall through */
    }
  }
  const words = beat.text.trim().split(/\s+/).filter(Boolean).length
  return Math.round((words / WPM) * 60_000)
}

// ── page helpers ────────────────────────────────────────────────────────────
const warnings = []
const warn = (msg) => {
  warnings.push(msg)
  console.warn('    ⚠ ' + msg)
}

function makeApi(page) {
  const demo = (fn, ...args) =>
    page.evaluate(([f, a]) => window.__demo && window.__demo[f](...a), [fn, args]).catch(() => {})

  const sleep = (ms) => page.waitForTimeout(FAST ? Math.min(ms, 100) : ms)

  async function rectOf(sel, { timeout = 6000 } = {}) {
    const loc = typeof sel === 'string' ? page.locator(sel).first() : sel
    try {
      await loc.waitFor({ state: 'visible', timeout })
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 })
      await page.waitForTimeout(FAST ? 60 : 420)
      const box = await loc.boundingBox()
      if (!box) return null
      return { x: box.x, y: box.y, width: box.width, height: box.height, loc }
    } catch {
      return null
    }
  }

  const api = {
    page,
    sleep,
    rectOf,
    warn,
    // Scene 2 shoots the agent live only on request — see the note in beats.js.
    liveAgent: has('live-agent'),

    async goto(pathname) {
      // Leaving a contract detail page stalls: the URL changes but nothing
      // renders for ~30s, with no pending request and no console error. A
      // cross-document teardown clears it instantly — measured 39.3s → 0.4s —
      // so bounce through about:blank on the way out. Costs a few frames of
      // white, which reads as a cut; the alternative was 39 seconds of silence.
      // (The app itself has the same stall on sidebar navigation — see the
      // note in README, "Known gaps".)
      if (/\/contracts\/[^/?]+$/.test(page.url())) {
        await page.goto('about:blank', { waitUntil: 'load', timeout: 10_000 }).catch(() => {})
      }
      // 'networkidle' as a goto condition is a trap here too: the app shell
      // polls, so on some screens it never fires and the navigation burns its
      // whole timeout. Wait for load, cap the quiet period, and let the
      // per-element waits in rectOf() decide when the screen is actually ready.
      await page.goto(BASE + pathname, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
      await page.waitForLoadState('networkidle', { timeout: FAST ? 800 : 5000 }).catch(() => {})
      await page.waitForTimeout(FAST ? 120 : 400)
      await demo('mount')
    },

    async pointTo(sel, { ms = 750 } = {}) {
      const r = await rectOf(sel)
      if (!r) return warn(`pointTo: not found — ${String(sel)}`), null
      await demo('moveTo', r.x + r.width / 2, r.y + r.height / 2, FAST ? 100 : ms)
      return r
    },

    async clickOn(sel, { ms = 750, settle = 900 } = {}) {
      const r = await api.pointTo(sel, { ms })
      if (!r) return null
      await demo('press')
      await sleep(140)
      try {
        await r.loc.click({ timeout: 5000 })
      } catch {
        warn(`clickOn: click failed — ${String(sel)}`)
        return null
      }
      await sleep(settle)
      await demo('mount')
      return r
    },

    async typeInto(sel, text, { delay = 34 } = {}) {
      const r = await api.clickOn(sel, { settle: 200 })
      if (!r) return null
      await page.keyboard.type(text, { delay: FAST ? 2 : delay })
      return r
    },

    async spot(sel, opts = {}) {
      const r = await rectOf(sel)
      if (!r) return warn(`spot: not found — ${String(sel)}`), null
      await demo('spotlight', { x: r.x, y: r.y, width: r.width, height: r.height }, opts)
      api._lastSpot = { sel, opts } // so it can be re-measured after the settle
      return r
    },

    /** Spotlight the CARD a piece of text sits in, not the text node itself.
     *  Ringing a bare heading reads as a misfire; the panel it titles is what
     *  the viewer is being pointed at. Climbs to the nearest bordered/rounded
     *  ancestor, which is what a card is in this design system. */
    async spotCard(text, opts = {}) {
      const loc = page.getByText(text, { exact: true }).first()
      try {
        await loc.waitFor({ state: 'visible', timeout: 6000 })
        await loc.scrollIntoViewIfNeeded({ timeout: 2000 })
        await page.waitForTimeout(FAST ? 60 : 400)
      } catch {
        return warn(`spotCard: not found — ${text}`), null
      }
      const box = await loc
        .evaluate((el) => {
          let n = el
          for (let i = 0; i < 6 && n.parentElement; i++) {
            const p = n.parentElement
            const cs = getComputedStyle(p)
            const bordered =
              parseFloat(cs.borderTopWidth) > 0 ||
              cs.boxShadow !== 'none' ||
              parseFloat(cs.borderTopLeftRadius) > 4
            n = p
            if (bordered && p.getBoundingClientRect().height > el.getBoundingClientRect().height * 1.5) {
              break
            }
          }
          const r = n.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        })
        .catch(() => null)
      if (!box) return warn(`spotCard: no box — ${text}`), null
      await demo('spotlight', box, opts)
      api._lastSpot = { card: text, opts }
      return box
    },

    clearSpot: () => {
      api._lastSpot = null
      return demo('clearSpotlight')
    },

    /** Re-measure and re-apply the current highlight. Run after the settle
     *  pause: rails finish expanding, images land, lists reflow — and a ring
     *  measured before that lands next to its subject rather than on it. */
    async reassertSpot() {
      const last = api._lastSpot
      if (!last) return
      if (last.card) await api.spotCard(last.card, last.opts)
      else await api.spot(last.sel, last.opts)
    },

    async say(text) {
      if (!CAPTIONS) return
      await demo('caption', text)
    },
    clearSay: () => demo('clearCaption'),

    async zoomOn(sel, scale = 1.35, ms = 900) {
      let r = await rectOf(sel)
      if (!r) return warn(`zoomOn: not found — ${String(sel)}`), null
      // Centre the target BEFORE scaling. scrollIntoViewIfNeeded does the
      // minimum, leaving it hard against an edge, and the pan clamp inside
      // zoom() cannot rescue that — it would only drag blank space into frame.
      // scrollIntoView({block:'center'}) is used rather than a hand-rolled
      // offset because it resolves the real scroll container itself; several of
      // these screens scroll an inner element, not the document.
      await r.loc
        .evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }))
        .catch(() => {})
      await page.waitForTimeout(FAST ? 80 : 650)
      r = (await rectOf(sel)) ?? r
      // Centre on the target only where the target actually fits in the zoomed
      // frame. Centring on the midpoint of something wider than the frame just
      // slides its far edge out of view, so those fall back to the viewport
      // centre and let the clamp keep both edges.
      const anchorX = r.width > (W / scale) * 0.9 ? W / 2 : r.x + r.width / 2
      const anchorY = r.height > (H / scale) * 0.9 ? H / 2 : r.y + r.height / 2
      await demo('zoom', anchorX, anchorY, scale, FAST ? 100 : ms)
      return r
    },
    unzoom: (ms = 700) => demo('unzoom', FAST ? 100 : ms),

    async scrollBy(px, ms = 1200) {
      await page
        .evaluate(
          ([d, dur]) => {
            // document.scrollingElement is never null, so a `||` chain always
            // stops there — even when the page actually scrolls an inner
            // element. Pick whichever candidate has real overflow instead.
            const cands = [
              document.scrollingElement,
              document.querySelector('main'),
              ...document.querySelectorAll('main div, [role="main"] div'),
            ]
            let el = document.scrollingElement
            let most = (el?.scrollHeight ?? 0) - (el?.clientHeight ?? 0)
            for (const c of cands) {
              if (!c || c === document.scrollingElement) continue
              const over = c.scrollHeight - c.clientHeight
              if (over > most && /auto|scroll/.test(getComputedStyle(c).overflowY)) {
                el = c
                most = over
              }
            }
            const start = el.scrollTop
            const t0 = performance.now()
            return new Promise((res) => {
              const step = (now) => {
                const t = Math.min(1, (now - t0) / dur)
                const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
                el.scrollTop = start + d * e
                t < 1 ? requestAnimationFrame(step) : res()
              }
              requestAnimationFrame(step)
            })
          },
          [px, FAST ? 100 : ms]
        )
        .catch(() => {})
      await page.waitForTimeout(FAST ? 40 : 180)
    },
  }
  return api
}

// ── run ─────────────────────────────────────────────────────────────────────
const overlaySrc = fs.readFileSync(path.join(__dirname, 'overlay.js'), 'utf8')

const browser = await chromium.launch({
  args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--disable-extensions'],
})
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: W, height: H } },
  colorScheme: 'light',
  reducedMotion: 'no-preference',
})
await context.addInitScript(overlaySrc)

// The in-context Ask rail defaults open at this width and eats 420px of frame
// on every list screen. Real preference, real control — we set it, not hide it.
if (!has('rail')) {
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('side-agent-rail:open', '0')
    } catch {
      /* private mode — the rail just stays open */
    }
  })
}
// First-run coach marks are one-shot onboarding a real user dismissed long ago.
await context.addInitScript(() => {
  try {
    window.localStorage.setItem('clm.coach.contract-detail.v2', 'seen')
  } catch {
    /* it auto-dismisses after 5s anyway */
  }
})

const page = await context.newPage()
const videoStartedAt = Date.now()
const a = makeApi(page)

console.log('→ signing in as the seeded demo account')
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 30_000 })
await page.fill('input[type="email"]', EMAIL)
await page.fill('input[type="password"]', PASSWORD)
await page.click('button[type="submit"]')
await page
  .waitForURL((u) => !u.toString().includes('/login'), { timeout: 30_000 })
  .catch(() => console.error('✖ login did not complete — is the API on :3001 seeded?'))
await page.waitForTimeout(1500)

const scenes = SCENES.filter((s) => !ONLY || ONLY.includes(String(s.id)))
const timeline = []
const t0 = Date.now()
let missingAudio = 0

for (const scene of scenes) {
  console.log(`\n→ scene ${scene.id} — ${scene.title}`)
  for (const [i, beat] of scene.beats.entries()) {
    const id = `beat-${String(scene.id).padStart(2, '0')}-${i + 1}`
    const dur = FAST ? 0 : beatDuration({ ...beat, id })
    if (!audioFor(id)) missingAudio++

    let audioStartMs
    let actionMs

    if (beat.overlap) {
      // The line narrates the wait, so it plays across it rather than after.
      const started = Date.now()
      audioStartMs = started - t0
      try {
        await beat.run(a)
      } catch (e) {
        warn(`${id} threw: ${e.message}`)
      }
      actionMs = Date.now() - started
      if (dur > actionMs) await page.waitForTimeout(dur - actionMs)
    } else {
      // Action first, screen settles, THEN the line. This is the whole fix.
      const started = Date.now()
      try {
        await beat.run(a)
      } catch (e) {
        warn(`${id} threw: ${e.message}`)
      }
      actionMs = Date.now() - started
      if (!FAST) {
        await page.waitForTimeout(SETTLE_MS)
        await a.reassertSpot()
        await page.waitForTimeout(180)
      }
      audioStartMs = Date.now() - t0
      if (dur > 0) await page.waitForTimeout(dur)
    }

    const overrun = beat.overlap && actionMs > dur ? ` (+${((actionMs - dur) / 1000).toFixed(1)}s silent)` : ''
    console.log(
      `   ${id}  audio @ ${(audioStartMs / 1000).toFixed(1)}s  ${(dur / 1000).toFixed(1)}s${overrun}` +
        `   “${beat.text.slice(0, 52)}${beat.text.length > 52 ? '…' : ''}”`
    )

    if (SHOTS) {
      await page.screenshot({ path: path.join(OUT, `${id}.png`) }).catch(() => {})
    }

    timeline.push({
      id,
      scene: scene.id,
      index: i + 1,
      text: beat.text,
      overlap: !!beat.overlap,
      audioStartMs,
      durationMs: dur,
      actionMs,
    })
  }
}

const leadInMs = t0 - videoStartedAt
await page.waitForTimeout(900)
const video = page.video()
await context.close()
await browser.close()

const raw = video ? await video.path() : null
fs.writeFileSync(
  path.join(OUT, 'timeline.json'),
  JSON.stringify({ leadInMs, width: W, height: H, settleMs: SETTLE_MS, beats: timeline, warnings }, null, 2)
)

if (raw && fs.existsSync(raw)) {
  const mp4 = path.join(OUT, 'draftlegal-demo.mp4')
  console.log('\n→ encoding (trimming the sign-in lead-in)')
  execFileSync(
    'ffmpeg',
    ['-y', '-ss', (leadInMs / 1000).toFixed(3), '-i', raw, '-c:v', 'libx264', '-preset', 'slow',
     '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', mp4],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  fs.rmSync(raw, { force: true })
  console.log(`✓ ${path.relative(REPO_ROOT, mp4)}`)
  console.log(`✓ ${path.relative(REPO_ROOT, path.join(OUT, 'timeline.json'))}`)
} else {
  console.error('✖ no video was produced')
}

if (missingAudio && !FAST) {
  console.log(
    `\n⚠ ${missingAudio} beat(s) had no audio — timing was estimated at ${WPM} wpm.` +
      `\n  Generate it with: node scripts/demo-video/tts.mjs`
  )
}
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`)
  for (const w of warnings) console.log('  · ' + w)
}

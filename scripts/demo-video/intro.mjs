#!/usr/bin/env node
/**
 * intro.mjs — the brand bumper: a draft becoming binding, drawn on camera.
 *
 * Standalone. It produces its own file and is never spliced into the demo;
 * the concat command is printed at the end if you want it on the front.
 *
 *   node scripts/demo-video/intro.mjs
 *   node scripts/demo-video/intro.mjs --seconds 3.6 --dark
 *   node scripts/demo-video/intro.mjs --audio path/to/vo.wav
 *   node scripts/demo-video/intro.mjs --silent
 *
 * ── The idea ────────────────────────────────────────────────────────────────
 *
 * apps/web/src/components/brand/Wordmark.tsx is explicit that the colour split
 * IS the identity: "draft" in pencil grey is work in progress, "Legal" in
 * emerald is signed and final, and the brand is drafts *becoming* binding. A
 * logo fading up says none of that. So the clip shows the thing happening — a
 * page is drafted in grey, marked up in red, then signed in emerald, and the
 * wordmark resolves out of the moment it becomes binding.
 *
 * ── The craft ───────────────────────────────────────────────────────────────
 *
 * Line art that DRAWS ITSELF, via anime.js v4 `svg.createDrawable` (stroke
 * dashoffset) rather than opacity fades — a stroke appearing is a stroke being
 * made. The pen rides the signature path with `svg.createMotionPath`, so the
 * ink follows a nib instead of materialising: the figure participates in the
 * action rather than decorating it. A feTurbulence displacement gives the ink
 * its hand tremor, applied only to the illustration — never to type.
 *
 * ── The sync ────────────────────────────────────────────────────────────────
 *
 * If docs/demo-video/vo/intro.wav exists, the clip is cut TO it. The last real
 * pause in the recording is found with ffmpeg silencedetect and treated as the
 * breath before the brand name; every beat is then placed as a proportion of
 * the run-up to that cue. So the signature completes in the pause and the
 * wordmark resolves on the word — and re-recording the voiceover re-cuts the
 * animation rather than requiring it to be re-tuned by hand.
 *
 * Pass --silent for a bumper with no narration.
 *
 * Output: out/draftlegal-intro.mp4
 */
import { chromium } from 'playwright'
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
const has = (n) => argv.includes(`--${n}`)

const OUT = path.resolve(flag('out', path.join(__dirname, 'out')))
// An illustrated sequence needs room to read. Below ~3.5s the signature stops
// landing as a moment and starts looking like a glitch.
let SECONDS = Math.max(3, Math.min(9, Number(flag('seconds', '5.4'))))
const DARK = has('dark')
// Artwork iterates far faster as a still than as a 4.6s render — this draws the
// finished frame and screenshots it, so composition can be judged in seconds.
const STILL = has('still')
// Narration, if there is any. A bumper does not need it, but when it exists the
// picture should be cut to the voice rather than the other way round.
const AUDIO = flag('audio', path.join(REPO_ROOT, 'docs/demo-video/vo/intro.wav'))
const HAS_AUDIO = !has('silent') && fs.existsSync(AUDIO)
const W = 1920
const H = 1080
fs.mkdirSync(OUT, { recursive: true })

// Copied exactly from apps/web/tailwind.config.ts. A bumper that is *nearly*
// the brand colour is worse than no bumper.
const C = DARK
  ? { paper: '#17161A', ink: '#D8D6CF', graphite: '#8A8880', brand: '#34D399', red: '#F87171', mark: '#B9B7B0' }
  : { paper: '#FAFAF9', ink: '#17161A', graphite: '#8A8880', brand: '#047857', red: '#DC2626', mark: '#57554F' }

/** Where the brand name is spoken, in seconds.
 *
 *  The whole clip hangs off this one number: the signature has to finish in the
 *  breath BEFORE the name, and the wordmark has to resolve ON it. Rather than
 *  hand-tuning that against one recording, find the last real pause in the
 *  narration — the comma in "…companion, Draft Legal" — and treat what follows
 *  as the name. Re-record the voiceover and the animation re-cuts itself. */
function findNameCue(file, dur) {
  try {
    const out = execFileSync(
      'ffmpeg',
      ['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-32dB:d=0.10', '-f', 'null', '-'],
      { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] }
    )
    const ends = [...out.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]))
    // The last pause that still leaves room for a couple of words after it.
    const cue = ends.filter((t) => t > dur * 0.35 && t < dur - 0.45).pop()
    return cue ?? dur * 0.72
  } catch {
    return dur * 0.72
  }
}

let AUDIO_DUR = 0
let NAME_AT = 0
if (HAS_AUDIO) {
  AUDIO_DUR = Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', AUDIO],
      { encoding: 'utf8' }).trim()
  )
  NAME_AT = findNameCue(AUDIO, AUDIO_DUR)
}

if (HAS_AUDIO && !argv.includes('--seconds')) {
  // A held beat after the last word, so the clip does not cut on the syllable.
  SECONDS = Math.min(9, AUDIO_DUR + 0.35)
}

const animeSrc = fs.readFileSync(path.join(__dirname, 'vendor', 'anime.esm.js'), 'utf8')

// ── artwork ─────────────────────────────────────────────────────────────────
// Generated rather than hand-written as literal path data: 24 documents each
// needing their own jitter is not something to type out, and a seeded PRNG
// means the same drawing every render — a bumper that reshuffles itself each
// build is not a brand asset.
let _seed = 20260817
const rnd = () => (_seed = (_seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const j = (n) => (rnd() - 0.5) * 2 * n

/** A rectangle drawn as four separate strokes that OVERSHOOT their corners.
 *  This is the tell of a real pen — a closed path with a wobble filter over it
 *  reads as a wobbly rectangle, not as something someone drew. */
function handRect(x, y, w, h, o = 5, jit = 2.4) {
  const X = x, Y = y, R = x + w, B = y + h
  return [
    `M ${X - j(jit)} ${Y + j(jit)} L ${R + o + j(jit)} ${Y + j(jit)}`,
    `M ${R + j(jit)} ${Y - o + j(jit)} L ${R + j(jit)} ${B + o + j(jit)}`,
    `M ${R + o + j(jit)} ${B + j(jit)} L ${X - j(jit)} ${B + j(jit)}`,
    `M ${X + j(jit)} ${B + o + j(jit)} L ${X + j(jit)} ${Y - o + j(jit)}`,
  ]
}

const hline = (x, y, w, wob = 3) =>
  `M ${x} ${y} Q ${x + w / 2} ${y + j(wob)} ${x + w} ${y + j(wob)}`

// The portfolio: a field of drafts. 24 reads as "hundreds" without becoming
// wallpaper, and leaves one cell for the document the query lands on.
const COLS = 6, ROWS = 4
const CELL_W = 176, CELL_H = 196, GAP_X = 62, GAP_Y = 44
const GRID_W = COLS * CELL_W + (COLS - 1) * GAP_X
const GRID_H = ROWS * CELL_H + (ROWS - 1) * GAP_Y
const GRID_X = (1920 - GRID_W) / 2
const GRID_Y = (1080 - GRID_H) / 2
const HERO_COL = 2, HERO_ROW = 1 // off-centre: dead centre is inert

const cellAt = (c, r) => ({
  x: GRID_X + c * (CELL_W + GAP_X),
  y: GRID_Y + r * (CELL_H + GAP_Y),
})

let gridSvg = ''
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    const { x, y } = cellAt(c, r)
    const isHero = c === HERO_COL && r === HERO_ROW
    const strokes = handRect(x, y, CELL_W, CELL_H, 4, 1.8)
      .map((d) => `<path d="${d}" stroke="${C.graphite}" stroke-width="1.9"/>`)
      .join('')
    const lines = [0, 1, 2, 3]
      .map((i) => `<path d="${hline(x + 20, y + 42 + i * 30, CELL_W - 40 - (i === 3 ? 52 : 0), 2)}"
             stroke="${C.graphite}" stroke-width="${i === 0 ? 4.2 : 2.2}" opacity="${i === 0 ? 0.9 : 0.55}"/>`)
      .join('')
    gridSvg += `<g class="doc${isHero ? ' doc-hero-cell' : ''}"
        style="transform-origin:${x + CELL_W / 2}px ${y + CELL_H / 2}px">${strokes}${lines}</g>`
  }
}

// The hero, drawn full size where it ends up, then transformed back into its
// grid cell for the opening. Scaling a 176px drawing up 2.7x would show every
// approximation; scaling a full-size one DOWN hides them.
const HERO = { x: 300, y: 236, w: 470, h: 610 }
const heroCell = cellAt(HERO_COL, HERO_ROW)
const HERO_S = CELL_W / HERO.w
const HERO_TX = heroCell.x - HERO.x * HERO_S
const HERO_TY = heroCell.y - HERO.y * HERO_S

// ── cues ────────────────────────────────────────────────────────────────────
// With narration, every beat is pinned to a proportion of the run-up to the
// name, so the performance stretches or compresses with the recording instead
// of being tuned to one file. Without it, the same proportions of the clip.
const K = HAS_AUDIO ? NAME_AT : SECONDS * 0.76
const ms = (v) => Math.round(v * 1000)
const CUE = {
  grid:     ms(0),
  gridDur:  ms(K * 0.14),
  dim:      ms(K * 0.20),
  heroUp:   ms(K * 0.21),
  heroDur:  ms(K * 0.20),
  edges:    ms(K * 0.28),
  edgesDur: ms(K * 0.18),
  body:     ms(K * 0.45),
  bodyDur:  ms(K * 0.20),
  marks:    ms(K * 0.66),
  marksDur: ms(K * 0.08),
  rule:     ms(K * 0.74),
  ruleDur:  ms(K * 0.05),
  pen:      ms(K * 0.78),
  sign:     ms(K * 0.80),
  // The signature finishes exactly as the name begins — the emerald stroke
  // lands in the breath before it, which is the whole reason to cut to voice.
  signDur:  ms(K * 0.20),
  word:     ms(K * 1.0),
  wordDur:  ms(Math.min(0.62, K * 0.16)),
}


// Every timing below is a fraction of the clip, so --seconds rescales the whole
// performance instead of just clipping the end off it.
const html = `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@500;700&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:100%;height:100%;background:${C.paper};overflow:hidden}
  body{display:flex;align-items:center;justify-content:center;
       font-family:'IBM Plex Sans',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  svg{width:${W}px;height:${H}px;display:block}
  .ink{fill:none;stroke-linecap:round;stroke-linejoin:round}
  #pen,#wordmark{opacity:0}
  .doc{opacity:0}
  #hero{transform-origin:0 0}
</style></head>
<body>
<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Tremor only, and gently. The hand-drawn quality now comes from the
         geometry itself — strokes that overshoot their corners, uneven line
         weights — because a displacement map over uniform strokes reads as
         "wobbly", not as "someone drew this". Type stays outside the filter. -->
    <filter id="tremor" x="-6%" y="-6%" width="112%" height="112%">
      <feTurbulence type="fractalNoise" baseFrequency="0.021" numOctaves="2" seed="11" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="2.1"
                         xChannelSelector="R" yChannelSelector="G"/>
    </filter>
  </defs>

  <!-- THE PORTFOLIO. Every contract you own, as drafts. -->
  <g id="grid" filter="url(#tremor)">${gridSvg}</g>

  <!-- THE ONE THE QUESTION LANDS ON. Starts folded into its grid cell. -->
  <g id="hero" filter="url(#tremor)"
     style="transform:translate(${HERO_TX}px,${HERO_TY}px) scale(${HERO_S})">
    <rect id="hero-fill" x="${HERO.x}" y="${HERO.y}" width="${HERO.w}" height="${HERO.h}"
      fill="${C.paper}" opacity="0"/>
    ${handRect(HERO.x, HERO.y, HERO.w, HERO.h, 9, 3)
      .map((d, i) => `<path class="ink hero-edge" d="${d}" stroke="${C.ink}" stroke-width="${3.1 + (i % 2) * 0.7}"/>`)
      .join('\n    ')}

    <path class="ink hero-body" d="${hline(HERO.x + 54, HERO.y + 84, 190, 3)}"
      stroke="${C.mark}" stroke-width="7.5"/>
    <path class="ink hero-body" d="${hline(HERO.x + 54, HERO.y + 156, 366, 3)}"
      stroke="${C.graphite}" stroke-width="3.5"/>
    <path class="ink hero-body" d="${hline(HERO.x + 54, HERO.y + 198, 362, 3)}"
      stroke="${C.graphite}" stroke-width="3.1"/>
    <path class="ink hero-body" d="${hline(HERO.x + 54, HERO.y + 240, 288, 3)}"
      stroke="${C.graphite}" stroke-width="3.4"/>
    <path class="ink hero-body" d="${hline(HERO.x + 54, HERO.y + 318, 364, 3)}"
      stroke="${C.graphite}" stroke-width="3.2"/>
    <path class="ink hero-body" d="${hline(HERO.x + 54, HERO.y + 360, 258, 3)}"
      stroke="${C.graphite}" stroke-width="3.5"/>

    <!-- struck, and queried in the margin -->
    <path id="mark1" class="ink" stroke="${C.red}" stroke-width="3.4"
      d="${hline(HERO.x + 158, HERO.y + 320, 226, 2)}"/>
    <path id="mark2" class="ink" stroke="${C.red}" stroke-width="3.2"
      d="M ${HERO.x + 20} ${HERO.y + 328} L ${HERO.x + 36} ${HERO.y + 308} L ${HERO.x + 52} ${HERO.y + 328}"/>

    <path id="rule" class="ink" stroke="${C.graphite}" stroke-width="2.6"
      d="${hline(HERO.x + 58, HERO.y + 520, 326, 2)}"/>

    <!-- THE SIGNATURE. The only emerald in the frame, and the only thing here
         drawn slowly. Tall entry stroke, base loop, uneven middles, trailing
         flourish — even humps read as a waveform, not a name. -->
    <path id="sign" class="ink" stroke="${C.brand}" stroke-width="5.8"
      d="M 360 756
         C 352 706 364 648 388 640
         C 410 633 414 674 402 710
         C 393 738 372 760 363 738
         C 356 721 376 710 395 721
         C 417 734 431 700 443 675
         C 454 656 469 663 471 686
         C 473 709 487 720 502 698
         C 519 673 538 684 546 707
         C 554 730 575 728 594 696
         C 615 660 642 673 665 700
         C 682 720 705 711 724 674"/>

    <!-- the nib that makes it -->
    <g id="pen">
      <path class="ink" stroke="${C.ink}" stroke-width="3.6" d="M 0 0 L 30 -84"/>
      <path class="ink" stroke="${C.ink}" stroke-width="3.6" d="M 30 -84 L 52 -75 L 23 9 Z"/>
      <path class="ink" stroke="${C.ink}" stroke-width="3.2" d="M 23 9 L 9 4"/>
    </g>
  </g>

  <g id="wordmark">
    <text x="1330" y="566" text-anchor="middle" font-size="116" letter-spacing="-2">
      <tspan fill="${C.mark}" font-weight="500">draft</tspan><tspan fill="${C.brand}" font-weight="700">Legal</tspan>
    </text>
  </g>
</svg>

<script type="module">
  import { animate, createTimeline, svg, stagger } from '/anime.esm.js'

  const STILL = ${STILL}
  const S = ${SECONDS} * 1000
  const at = (f) => S * f

  const hero = document.querySelector('#hero')

  if (STILL) {
    document.querySelector('#wordmark').style.opacity = 1
    document.querySelector('#pen').style.opacity = 0
    document.querySelector('#grid').style.opacity = 0.1
    document.querySelector('#hero-fill').style.opacity = 1
    hero.style.transform = 'none'
    document.querySelectorAll('.doc').forEach((d) => { d.style.opacity = 1 })
  } else {
    const draw = (sel) => {
      const d = svg.createDrawable(sel)
      d.forEach((el) => { el.draw = '0 0' })
      return d
    }
    const edges = draw('.hero-edge')
    const body = draw('.hero-body')
    const marks = draw('#mark1, #mark2')
    const rule = draw('#rule')
    const sign = draw('#sign')

    // Held, not autoplaying. The timeline used to start at module-eval while
    // the recording started at page-create, so the picture ran ~0.65s behind
    // the voice — invisible until the narration was cut against it. Node starts
    // it and trims the video from that same instant, so animation t=0, video
    // t=0 and audio t=0 are the same moment.
    const tl = createTimeline({ defaults: { ease: 'outQuad' }, autoplay: false })
    window.__start = () => tl.play()

    // 1. THE PORTFOLIO ARRIVES. Staggered from the centre, quick — this is the
    //    "every contract you own" beat, and it should feel like volume.
    tl.add('.doc', {
      opacity: [0, 1],
      duration: ${CUE.gridDur},
      ease: 'outQuad',
      delay: stagger(${Math.round(CUE.gridDur / 26)}, { from: 'center', grid: [6, 4] }),
    }, ${CUE.grid})

    // 2. …and one of them is the answer. The rest recede to texture.
    tl.add('.doc:not(.doc-hero-cell)', {
      opacity: 0.1, duration: ${CUE.heroDur}, ease: 'inOutQuad',
    }, ${CUE.dim})
    tl.add('.doc-hero-cell', { opacity: 0, duration: ${Math.round(CUE.heroDur / 3)} }, ${CUE.dim})

    // 3. It comes forward. Animate a plain object and write the transform
    //    ourselves: anime.js will not drive a CSS transform on an SVG <g>, so
    //    targeting the group directly leaves the computed matrix at its start
    //    value, silently — the page stayed thumbnail-sized for a whole cut
    //    before a probe caught it.
    const cam = { k: ${HERO_S}, tx: ${HERO_TX}, ty: ${HERO_TY} }
    tl.add(cam, {
      k: 1, tx: 0, ty: 0,
      duration: ${CUE.heroDur},
      ease: 'inOutCubic',
      onUpdate: () => {
        hero.style.transform =
          'translate(' + cam.tx + 'px,' + cam.ty + 'px) scale(' + cam.k + ')'
      },
    }, ${CUE.heroUp})
    tl.add('#hero-fill', { opacity: [0, 1], duration: ${Math.round(CUE.heroDur * 0.6)} }, ${CUE.heroUp})

    // 4. Now it is legible, it gets read: the paper, then what is on it.
    tl.add(edges, { draw: '0 1', duration: ${CUE.edgesDur}, delay: stagger(${Math.round(CUE.edgesDur / 6)}) }, ${CUE.edges})
    tl.add(body, { draw: '0 1', duration: ${Math.round(CUE.bodyDur * 0.7)}, delay: stagger(${Math.round(CUE.bodyDur / 7)}) }, ${CUE.body})

    // 5. One clause struck, and questioned in the margin.
    tl.add(marks, { draw: '0 1', duration: ${CUE.marksDur}, delay: stagger(${Math.round(CUE.marksDur / 2)}) }, ${CUE.marks})
    tl.add(rule, { draw: '0 1', duration: ${CUE.ruleDur} }, ${CUE.rule})

    // 6. THE MOMENT — timed to finish in the breath before the name.
    tl.add('#pen', { opacity: [0, 1], duration: ${Math.round(CUE.signDur * 0.15)} }, ${CUE.pen})
    tl.add('#pen', {
      duration: ${CUE.signDur}, ease: 'inOutSine', ...svg.createMotionPath('#sign'),
    }, ${CUE.sign})
    tl.add(sign, { draw: '0 1', duration: ${CUE.signDur}, ease: 'inOutSine' }, ${CUE.sign})
    tl.add('#pen', { opacity: 0, duration: ${Math.round(CUE.signDur * 0.2)} }, ${CUE.word - 60})

    // 7. And the name resolves ON the name.
    tl.add('#wordmark', {
      opacity: [0, 1], translateY: [18, 0],
      duration: ${CUE.wordDur}, ease: 'outCubic',
    }, ${CUE.word})
  }

  window.__ready = true
</script>
</body></html>`

const browser = await chromium.launch({
  args: ['--hide-scrollbars', '--force-device-scale-factor=1', '--disable-lcd-text'],
})
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: W, height: H } },
  colorScheme: DARK ? 'dark' : 'light',
  reducedMotion: 'no-preference',
})
const page = await context.newPage()
// Without this a broken animation module fails silently and the only symptom is
// a blank clip — which cost a full render cycle to work out more than once.
page.on('pageerror', (e) => console.error('  page error: ' + e.message.split('\n')[0]))
page.on('console', (m) => {
  if (m.type() === 'error') console.error('  console: ' + m.text().slice(0, 200))
})

// A routed fake origin, so the page can `import` anime.js as a real module.
// setContent() leaves the document on about:blank, where module resolution and
// relative URLs both fail.
await page.route('https://intro.local/**', (route) => {
  const p = new URL(route.request().url()).pathname
  if (p === '/anime.esm.js') {
    return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: animeSrc })
  }
  return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html })
})

const videoStartedAt = Date.now()
await page.goto('https://intro.local/index.html', { waitUntil: 'load' })
await page.waitForFunction(() => window.__ready === true, { timeout: 15_000 }).catch(() => {
  console.error('✖ the animation module never initialised — check for a JS error in the page')
})
// Fonts before the first frame: otherwise the wordmark renders in the fallback
// face and visibly reflows partway through a five-second clip.
await page.evaluate(() => document.fonts.ready).catch(() => {})

if (STILL) {
  const png = path.join(OUT, `intro-still${DARK ? '-dark' : ''}.png`)
  await page.screenshot({ path: png })
  await context.close()
  await browser.close()
  console.log(`✓ ${path.relative(REPO_ROOT, png)}  (finished frame, for judging the artwork)`)
  process.exit(0)
}

// Let the recorder settle on a still frame, then start the performance from
// here. The timeline is built with autoplay:false precisely so this instant can
// be the shared zero for all three clocks — it used to start at module-eval
// while recording started at page-create, which put the picture ~0.65s behind
// the voice. Invisible until there was a voice to be behind.
await page.waitForTimeout(400)
const startedAt = Date.now()
await page.evaluate(() => window.__start && window.__start()).catch(() => {})
await page.waitForTimeout(SECONDS * 1000 + 350)

const leadInMs = startedAt - videoStartedAt
const video = page.video()
await context.close()
await browser.close()

const raw = video ? await video.path() : null
if (!raw || !fs.existsSync(raw)) {
  console.error('✖ no video was produced')
  process.exit(1)
}

const mp4 = path.join(OUT, `draftlegal-intro${DARK ? '-dark' : ''}.mp4`)
// The narration goes on at full level with no processing — it is a five-second
// line, not a mix. -shortest is deliberately absent: the clip is already cut to
// the audio, and letting ffmpeg trim to whichever stream ends first would clip
// the held beat off the end.
const vArgs = ['-ss', (leadInMs / 1000).toFixed(3), '-t', String(SECONDS), '-i', raw]
const aArgs = HAS_AUDIO ? ['-i', AUDIO] : []
const mapArgs = HAS_AUDIO
  ? ['-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000']
  : ['-an']
execFileSync(
  'ffmpeg',
  ['-y', ...vArgs, ...aArgs,
   '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', '30',
   ...mapArgs, '-movflags', '+faststart', mp4],
  { stdio: ['ignore', 'ignore', 'pipe'] }
)
fs.rmSync(raw, { force: true })

const dur = execFileSync(
  'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4],
  { encoding: 'utf8' }
).trim()
console.log(
  `✓ ${path.relative(REPO_ROOT, mp4)}  (${Number(dur).toFixed(2)}s, ${W}x${H}, ` +
  (HAS_AUDIO ? `narrated — name cue at ${NAME_AT.toFixed(2)}s)` : 'silent)')
)
console.log(`
  On the front of the demo, re-encoding both so the join is seamless:

    ffmpeg -i ${path.relative(REPO_ROOT, mp4)} -i scripts/demo-video/out/draftlegal-demo-vo.mp4 \\
      -filter_complex "[0:v]setsar=1[a];[1:v]setsar=1[b];[a][b]concat=n=2:v=1[v]" \\
      -map "[v]" -map 1:a -c:v libx264 -crf 18 -pix_fmt yuv420p \\
      scripts/demo-video/out/draftlegal-demo-with-intro.mp4
`)

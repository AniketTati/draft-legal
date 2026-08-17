# Demo video toolkit

Records the product tour in [`docs/demo-video/SCRIPT.md`](../../docs/demo-video/SCRIPT.md) as a
1920×1080 MP4, with an animated pointer, click ripples, a spotlight that dims everything but the
thing being discussed, and camera pushes on the moments that need one — then lays your narration
onto it, locked to the picture.

Nothing here is a screen recorder pointed at your desktop. The browser is driven by Playwright, so
a take is deterministic and repeatable: when a screen changes, you re-run one command instead of
re-recording by hand.

```bash
pnpm dev                                    # web :5173, api :3001, agents :8002 must be up
node scripts/demo-video/tts.mjs --sample            # audition voices
node scripts/demo-video/tts.mjs --voice Charon      # one audio file per line
node scripts/demo-video/record.mjs --fast           # rehearse: ~60s, checks every selector
node scripts/demo-video/record.mjs                  # the real take
node scripts/demo-video/mux.mjs                     # lay the narration on
node scripts/demo-video/verify.mjs                  # frame-by-line sync check
```

## The pieces

| File | What it does |
|------|--------------|
| `beats.js` | **The source of truth.** Every line of narration next to the visual it describes. Edit the demo here; the `.txt` scripts are regenerated from it. |
| `tts.mjs` | Generates one audio file per beat with Gemini TTS, into `vo/beats/`. Also rewrites the human-readable `.txt` scripts. |
| `overlay.js` | Injected into every page. Draws the pointer, ripple, spotlight, captions and zoom. All `pointer-events:none`, so real clicks pass through it. |
| `record.mjs` | Runs each beat, waits for the screen, holds for that line, records, encodes, writes `timeline.json`. |
| `mux.mjs` | Places each beat's audio at the offset the recorder measured for it. Optional music bed. |
| `verify.mjs` | Pulls the frame from the middle of every line so you can check picture against voice. |
| `prep.mjs` | Stages a playbook redline ahead of a take, so a slow model call doesn't land mid-scene. Not needed for the current script — see the known gap below. |

## Narration

`tts.mjs` uses the Gemini API (`generativelanguage.googleapis.com`), reading `GOOGLE_API_KEY` or
`GEMINI_API_KEY` from the environment or the repo-root `.env` and sending it as a header — never in
a URL, never logged. Cloud Text-to-Speech (`texttospeech.googleapis.com`) is the other option and is
the one that takes SSML, but it returns 403 on this project's key, so it is not wired up.

Delivery is set by a plain-language instruction rather than SSML markup — see `STYLE` in the script,
and `--style` to override. Keep any override about *manner only*; anything that reads as content
risks being spoken aloud. The quick check is arithmetic: if a 30-word line comes back at 14 seconds
you are at ~129 wpm and the instruction was not read; if it comes back at 35 seconds, it was.

Voices worth trying: **Charon** (measured, the current default), **Kore** (brisker), **Algieba**
(smooth), **Iapetus** (slowest). `--sample` renders all four into `vo/samples/` to compare.

Regenerating is cheap and idempotent — existing MP3s are skipped unless you pass `--force`, so
changing one line of one scene costs one API call:

```bash
node scripts/demo-video/tts.mjs --voice Charon --scenes 6 --force
```

## How sync works

**The video leads, the audio follows.** Narration is split to the line level in `beats.js`, where
each line sits next to the visual action it describes. For each beat the recorder runs the action,
waits for the screen to settle, and only then starts that line. The thing being described is
therefore always already on screen — it cannot arrive after the words.

That is a deliberate trade. A slow page becomes a short silence instead of drift, because silence
reads as pacing and drift reads as broken. Beats marked `overlap: true` invert it — their line plays
*across* the action, which is right when the line narrates a wait (the agent thinking).

`mux.mjs` then places every line at the offset the recorder measured for it, one anchor per line
rather than one per scene. An earlier version anchored per scene and drifted up to twelve seconds
inside the long ones.

**Check it, don't trust it.** `verify.mjs` pulls the frame from the middle of every line and writes
it next to that line in `out/verify/index.md`. Read down the page: each image should already show
what its caption says. That check is what caught the two zoom framing bugs and a spotlight landing
on a panel that reports a false all-clear.

## Useful flags

```
--fast                 skip every hold — a ~45s pass to check the choreography
--shots                write the last frame of each beat as beat-NN-M.png
--scenes 2,6           record only those scenes
--settle 420           ms to let the screen stand still before a line starts
--captions             burn in lower-third captions (for a silent, autoplay cut)
--rail                 leave the in-context Ask rail open (default: collapsed)
--vo <dir>             where the narration audio lives
```

## State the recorder sets, and why

Two bits of local UI state are set before filming. Both are real preferences with real controls —
neither hides or fakes anything the product does:

- `side-agent-rail:open = 0` — the in-context Ask rail defaults open at 1920px and takes 420px of
  frame on every list screen. Collapsed is its documented state below 1280px, and the "Ask ⌘K" chip
  stays visible on the right edge.
- `clm.coach.contract-detail.v2 = seen` — the first-run coach mark. It auto-dismisses after five
  seconds anyway; a real user dismissed it months ago.

## Before a real take

1. **`pnpm dev` is up** and the agent has a provider key, or scene 2 records a failure.
2. **Check the spoken numbers.** Three numbers are said aloud; the table in `SCRIPT.md` says what
   each one must still match on screen.
3. **Rehearse with `--fast`.** Zero warnings means every selector still resolves; a warning names
   the beat and the selector that moved.
4. **Run `verify.mjs` after the take** and read `out/verify/index.md` top to bottom. Every frame
   should already show what its line says. This is the only check that catches a beat pointing at
   the wrong thing — the recorder cannot know that a selector resolved to something misleading.

## Known gaps in the current demo data

Both of these are about the seeded database, not the recorder. Neither blocks a take, and the
script as written does not claim either of them.

**The repository leads with test fixtures.** 102 of 424 contracts are `W0-2 *` NDA drafts from the
week-zero eval runs, and they sort to the top of an unfiltered `/contracts`. 40 of 130 agent threads
are probes (`probe2`, `Reply with exactly: OK`, `stream timing probe`) and they fill the left rail
of the Assistant screen. The recorder works around the first by filming a filtered view; it cannot
work around the second, because the thread list has no collapse control. Clearing those rows is the
only real fix.

**Playbook redline cannot be demonstrated.** Only 5 contracts in the database have extracted
clauses, and 3 of those are probes — so the redline pipeline has nothing to compare and returns
`"No clause deviated from the playbook."` with `uncoveredClauses: 0` on contracts it never actually
examined. That is a false all-clear, and it is the exact silent miss `PlaybookRedlineRailSection`'s
own header comment says the feature exists to prevent. Scene 5 was narrowed to the playbook itself
until clause extraction has been run across the portfolio. Once it has, `prep.mjs` stages a redline
ahead of the take and scene 5 can carry the counter-proposal half of the story again.

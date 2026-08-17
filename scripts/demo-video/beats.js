/**
 * beats.js — the demo, as beats. One source of truth for both halves.
 *
 * A beat is one line of narration paired with the visual it describes. They
 * live together in one object because that is the thing that kept breaking
 * when they lived apart: the script said one thing while the screen did
 * another, and nothing in the pipeline could notice.
 *
 * Three rules, each of them learned from a cut that looked wrong:
 *
 *   1. ONE VISUAL STATE PER BEAT. A beat that highlights two things in turn
 *      ends on the second, so its line plays over a screen that no longer
 *      matches its first half. Split it instead — a line per thing.
 *   2. HIGHLIGHT ONLY WHAT THE LINE NAMES. A spotlight on a generic sentence
 *      is a spotlight the viewer reads as meaningful and it isn't. Wide lines
 *      get the whole screen.
 *   3. TARGET TEST IDS, NOT PROSE. `text=/signed/i` matches half a page and
 *      the ring lands somewhere arbitrary. Every highlight below points at a
 *      stable data-testid, or at the card a known string sits in.
 *
 * The recorder runs `beat.run()`, waits for the screen to settle, re-asserts
 * the highlight, and only THEN starts that beat's audio — so the visual is
 * always in place before the line describing it. Where a beat narrates
 * something that takes time (the agent thinking), `overlap: true` plays the
 * line across the wait instead of after it.
 *
 * Editing narration here regenerates docs/demo-video/vo/*.txt — those are
 * outputs, do not edit them by hand.
 */

export const ROW = '[data-testid^="contract-row-"]'
export const SEARCH_BOX = 'input[placeholder*="Search by title" i]'
export const DETAIL_SEARCH = 'Acme Corporation'
export const HIGH_RISK_VIEW = '/contracts?riskBand=high&status=UNDER_NEGOTIATION'

export const SCENES = [
  {
    id: 1,
    slug: 'hook',
    title: 'The problem',
    beats: [
      {
        // No highlight: the line is about a situation, not about anything on
        // this screen in particular. The pointer drifting across the queue
        // counts is enough motion.
        text:
          'Every legal team runs on the same two problems. The contracts are somewhere. ' +
          'And nobody can answer a question about them without opening twenty of them.',
        async run(a) {
          await a.goto('/dashboard')
          await a.pointTo('[data-testid="your-day-band"]', { ms: 1200 })
        },
      },
      {
        text:
          'Draft Legal fixes both. It is an open source contract platform that runs on your own servers.',
        async run(a) {
          await a.scrollBy(320)
        },
      },
    ],
  },

  {
    id: 2,
    slug: 'ask-portfolio',
    title: 'Ask the portfolio',
    // Two ways to shoot this scene, chosen with --live-agent:
    //
    //   replay (default) — open a thread the product already answered. The
    //     answer, the tool call and the results table are all genuine output;
    //     they were just generated earlier. No model call during the take, so
    //     the scene cannot fail mid-recording and costs nothing.
    //   live — type it and wait. Better footage (you watch it think), but it
    //     adds ~40s of wall clock and needs API credit. A take recorded with a
    //     depleted key captures the error state instead of an answer, which is
    //     how this option came to exist.
    beats: [
      {
        text: 'Start with the thing most contract tools cannot do. Ask your whole portfolio a question.',
        async run(a) {
          await a.goto('/agent')
          if (a.liveAgent) {
            await a.clickOn('[data-testid="agent-new-conversation"]', { settle: 1200 })
          } else {
            // Pick a thread that actually completed — "1 tool" in the row means
            // the agent got as far as searching, so the artifact exists.
            const ok = await a.clickOn(
              '[data-testid^="thread-row-"]:has-text("A vendor quoted"):has-text("tool")',
              { settle: 2200 }
            )
            if (!ok) a.warn('scene 2: no completed vendor-quote thread to replay — run with --live-agent')
          }
        },
      },
      {
        text:
          'A vendor has quoted two hundred thousand dollars for an eight week statement of work. Is that fair?',
        async run(a) {
          if (a.liveAgent) {
            await a.typeInto(
              '[data-testid="agent-composer"]',
              'A vendor quoted us $200k for an 8-week SOW. Is that fair against what we have signed before?'
            )
          } else {
            await a.spot('[data-testid="agent-messages"] >> text=/A vendor quoted us/', { pad: 10 })
          }
        },
      },
      {
        text:
          'The assistant searches every contract you have actually signed, and answers from your own history. ' +
          'It is reading your own paper, not a general model guessing at what the market charges.',
        overlap: true,
        async run(a) {
          if (!a.liveAgent) {
            await a.clearSpot()
            await a.sleep(1200)
            return
          }
          await a.page.keyboard.press('Enter')
          await a.page
            .waitForSelector('[data-testid="agent-done"]', { state: 'attached', timeout: 120_000 })
            .catch(() => a.warn('scene 2: the answer never finished streaming'))
          await a.sleep(900)
        },
      },
      {
        // Not "it shows its working" — spoken aloud that is indistinguishable
        // from "it shows IT'S working", which means something else entirely.
        // Transcribing the generated audio is what surfaced it.
        text: 'And it shows you how it got there.',
        async run(a) {
          await a.clearSpot()
          await a.spot('[data-testid="agent-tool-chips"]', { pad: 10 })
        },
      },
      {
        text: 'Open the tool call, and you can see exactly what was searched and what came back.',
        async run(a) {
          await a.clearSpot()
          await a.clickOn('[data-testid^="tool-chip-"]', { settle: 1600 })
          // Newer threads open a results artifact; older ones expand the chip
          // inline to show ARGS and RESULT. Both satisfy the line — take
          // whichever this thread has rather than warning about the other.
          const pane = await a.rectOf('[data-testid="artifact-pane"]', { timeout: 2500 })
          await a.spot(
            pane ? '[data-testid="artifact-pane"]' : '[data-testid="agent-tool-chips"]',
            { pad: 12 }
          )
        },
      },
    ],
  },

  {
    id: 3,
    slug: 'repository',
    title: 'The repository',
    beats: [
      {
        text: 'Behind that answer is the repository. Every contract, parsed, classified, and scored for risk.',
        async run(a) {
          await a.clearSpot()
          await a.goto('/contracts?status=EXECUTED')
        },
      },
      {
        // No push-in: the row list is full-width, so any zoom crops a fifth of
        // it. The pagination line literally reads "Showing 3 of 3 contracts",
        // which is the narrowing this sentence describes.
        text:
          'Filter to what is high risk and still in negotiation, and the whole portfolio narrows to the few that genuinely need a lawyer today.',
        async run(a) {
          await a.goto(HIGH_RISK_VIEW)
          await a.spot('[data-testid="contracts-pagination"]', { pad: 14 })
        },
      },
    ],
  },

  {
    id: 4,
    slug: 'extraction',
    title: 'What it extracted',
    beats: [
      {
        text: 'Open any one of them.',
        async run(a) {
          await a.clearSpot()
          await a.goto('/contracts?status=EXECUTED')
          await a.typeInto(SEARCH_BOX, DETAIL_SEARCH)
          await a.sleep(1500) // debounce
          await a.clickOn(ROW, { settle: 2800 })
        },
      },
      {
        text:
          'Draft Legal has already pulled out the parties, the value, the term, and the renewal mechanics.',
        async run(a) {
          await a.spot('[data-testid="rail-section-key-terms"]', { pad: 10 })
        },
      },
      {
        text: "Down the side is the contract's whole state. What it commits you to, and when.",
        async run(a) {
          await a.spot('[data-testid="rail-section-obligations"]', { pad: 10 })
        },
      },
      {
        // Deliberately NOT the playbook-redline panel. On this data it reports
        // "0 clauses deviate" for a contract whose clauses were never
        // extracted — a false all-clear (see README, "Known gap"). Pointing the
        // camera at it would put that bug in the marketing video. Compliance
        // has real, checkable findings, so the claim lands on something true.
        text: 'Where it stands against GDPR, SOX and CCPA. And what has to be fixed before signature.',
        async run(a) {
          await a.spot('[data-testid="rail-section-compliance"]', { pad: 10 })
        },
      },
    ],
  },

  {
    id: 5,
    slug: 'playbook',
    title: 'The playbook',
    beats: [
      {
        text: 'Your playbook is the standard every contract gets measured against.',
        async run(a) {
          await a.clearSpot()
          await a.goto('/playbook')
          await a.clickOn('text=/^Limitation of Liability$/', { settle: 1400 })
        },
      },
      // One position per line. The earlier version lit two per beat, so each
      // line played over whichever one happened to be lit last.
      {
        text: 'For every clause type, the position you prefer.',
        async run(a) {
          await a.spot('[data-position-type="preferred"]', { pad: 10 })
        },
      },
      {
        text: 'The one you will sign without escalating.',
        async run(a) {
          await a.spot('[data-position-type="acceptable"]', { pad: 10 })
        },
      },
      {
        text: 'The one you concede, reluctantly.',
        async run(a) {
          await a.spot('[data-position-type="fallback"]', { pad: 10 })
        },
      },
      {
        text: 'And the point where you walk away.',
        async run(a) {
          await a.spot('[data-position-type="walkaway"]', { pad: 10 })
        },
      },
      {
        text:
          "That is what turns a contract review from one lawyer's judgement into something the whole team applies the same way.",
        async run(a) {
          await a.clearSpot()
          await a.clickOn('text=/^Indemnification$/', { settle: 1400 })
        },
      },
    ],
  },

  {
    id: 6,
    slug: 'approvals',
    title: 'Approvals',
    beats: [
      {
        text:
          'When a contract is ready to move, it moves on rails. Approvals route by value, by type, and by counterparty.',
        async run(a) {
          await a.clearSpot()
          await a.goto('/approvals')
        },
      },
      {
        // The whole card, not the recommendation badge — the line is about what
        // the approver receives, which is the summary and the verdict together.
        text:
          'Each one arrives with a summary and a recommendation, so an approver who has not read the contract still understands the decision.',
        async run(a) {
          await a.spot('[data-testid^="approval-card-"]:has-text("recommends")', { pad: 10 })
        },
      },
      {
        text:
          'Here, the liability cap sits far below our floor for a vendor holding production data. That is the whole reason this one needs finance to sign off.',
        async run(a) {
          await a.clearSpot()
          await a.zoomOn('[data-testid^="approval-card-"]:has-text("Airtable")', 1.4, 1100)
        },
      },
    ],
  },

  {
    id: 7,
    slug: 'signature',
    title: 'Signature',
    beats: [
      {
        text: 'Signature happens inside the platform.',
        async run(a) {
          await a.unzoom(600)
          await a.goto('/signatures')
        },
      },
      {
        text:
          'Send it, watch who has signed, and countersign without leaving the contract or paying for a separate tool.',
        async run(a) {
          await a.spot('[data-testid="signatures-table"]', { pad: 12 })
        },
      },
    ],
  },

  {
    id: 8,
    slug: 'obligations-renewals',
    title: 'After signature',
    beats: [
      {
        text: 'Signing is the middle of the story, not the end.',
        async run(a) {
          await a.clearSpot()
          await a.goto('/obligations')
        },
      },
      {
        text:
          'Every commitment you made is tracked and dated, so the ones running late surface before they turn into a problem.',
        async run(a) {
          await a.spot('[data-testid="stat-overdue"]', { pad: 12 })
        },
      },
      {
        text: 'Renewals are grouped by when the decision is actually due.',
        async run(a) {
          await a.clearSpot()
          await a.goto('/renewals')
        },
      },
      {
        text: 'Around twenty six million dollars of contract value comes up in the next ninety days.',
        async run(a) {
          await a.spot('[data-testid="stat-next-90"]', { pad: 12 })
        },
      },
    ],
  },

  {
    id: 9,
    slug: 'analytics',
    title: 'Analytics',
    beats: [
      {
        text: 'And all of it rolls up. Four hundred contracts.',
        async run(a) {
          await a.clearSpot()
          await a.goto('/analytics')
          await a.spot('[data-testid="kpi-total"]', { pad: 12 })
        },
      },
      {
        text: 'A hundred and forty six million dollars of executed value.',
        async run(a) {
          await a.spot('[data-testid="kpi-executed"]', { pad: 12 })
        },
      },
      {
        text: 'Cycle time, where deals get stuck, and how risk is spread across the book.',
        async run(a) {
          await a.clearSpot()
          await a.scrollBy(430)
        },
      },
    ],
  },

  {
    id: 10,
    slug: 'close',
    title: 'Where it runs',
    beats: [
      {
        text: 'Draft Legal runs on your infrastructure, with your own model provider.',
        async run(a) {
          await a.goto('/admin/org')
          await a.clickOn('text=/^AI Config$/', { settle: 1600 })
          await a.spotCard('Model routing', { pad: 10 })
        },
      },
      {
        text: 'Your contracts never leave your servers.',
        async run(a) {
          await a.spotCard('API keys (BYOK)', { pad: 10 })
        },
      },
      {
        text:
          'It is open source. Clone it, run one command, and it comes up with demo data already inside.',
        async run(a) {
          await a.clearSpot()
          await a.scrollBy(260)
        },
      },
    ],
  },
]

/** Stable id for a beat's audio file: beat-03-2 is scene 3, second beat. */
export const beatId = (sceneId, index) =>
  `beat-${String(sceneId).padStart(2, '0')}-${index + 1}`

/** Flat list of every beat, in order, with its scene and file stem attached. */
export function allBeats() {
  const out = []
  for (const scene of SCENES) {
    scene.beats.forEach((beat, i) => {
      out.push({ ...beat, scene: scene.id, slug: scene.slug, index: i, id: beatId(scene.id, i) })
    })
  }
  return out
}

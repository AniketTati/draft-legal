# Archived one-shot verification probes

153 `*-verify.mjs` scripts, written to confirm a specific fix at the moment it
landed and never run again. **149 of them were untouched since the initial
import commit**; the other four were touched once, by a mass find-and-replace
that changed a port number. None was ever listed in `scripts/evals/manifest.mjs`,
so nothing has run any of them since the day they were written.

They are archived rather than deleted because they document what was checked,
and a few may contain an assertion nothing else makes.

## Why not just wire them up

Because they would be red within a week and stay red. They assume a live seeded
stack, a particular fixture, and in several cases a service that is no longer on
that port. A permanently-red job is worse than no job: the standard response is
`continue-on-error: true`, which is the `|| true` pattern `docs/37` spent a wave
removing.

More importantly, while they sat in `scripts/` they **read as coverage**. An
audit of this repo counted 153 verification scripts and had to check each one to
discover that nothing runs them. Moving them here makes the real number visible.

## Resurrecting one

Do not run it from here and call it a check. Promote it properly:

1. Move it to `scripts/agent-loops/`.
2. Rewrite it against `scripts/week-zero/lib/harness.mjs` so it emits the
   canonical `<title>: <passed>/<total> passed` summary line the runner parses.
3. Add it to `scripts/evals/manifest.mjs` with a tier and its real `needs` —
   an unlisted check in that directory fails the run, which is the point.
4. **Watch it fail before trusting it.** Per `docs/36`, thirty-eight assertions
   in this repo passed against broken code; reverting the fix is the only thing
   that ever caught them.

If it does not assert something no existing check asserts, leave it here.

/**
 * Side-effect module: reconcile the two API-base env vars BEFORE the libraries
 * that read them are evaluated.
 *
 * scripts/week-zero/lib/harness.mjs reads API_BASE; scripts/persona-tests/lib.mjs
 * reads PERSONA_API. Set only one and half the suite silently talks to a
 * different server than the other half.
 *
 * This lives in its own module because ES imports are HOISTED: a plain
 * assignment at the top of targets.mjs runs AFTER every import in that file has
 * already been evaluated, so persona-tests/lib.mjs had captured
 * `process.env.PERSONA_API ?? 'http://localhost:3001'` before the assignment
 * happened. The bridge was dead code, and the chat corpus quietly ran against
 * the default server — reporting a bug that had already been fixed on the
 * server it was supposed to be testing.
 *
 * Imported first, a side-effect module DOES run first: imports are evaluated in
 * source order.
 */
if (!process.env.PERSONA_API && process.env.API_BASE) {
  process.env.PERSONA_API = process.env.API_BASE
}
if (!process.env.API_BASE && process.env.PERSONA_API) {
  process.env.API_BASE = process.env.PERSONA_API
}

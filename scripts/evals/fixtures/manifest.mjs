/** Fixture manifest for e1-gate-bites.mjs. Not part of the real suite. */
export const TIERS = ['t1']
export const CHECKS = [
  { id: 'passing',  tier: 't1', needs: [], what: 'a check that passes' },
  { id: 'failing',  tier: 't1', needs: [], what: 'a check that fails' },
  { id: 'empty',    tier: 't1', needs: [], what: 'a check that asserts nothing' },
]
export const CHECK_DIR = 'scripts/evals/fixtures/checks'

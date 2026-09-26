/**
 * Y5 — the one reader of NODE_ENV in the API, and the one place a security
 * check may relax.
 *
 * Checks keyed on `NODE_ENV !== 'production'` were open on staging and
 * previews (X31, X35, X39), a placeholder secret passed outside production
 * (X38), and about a dozen reads each had their own idea of what was safe.
 * The API is now strict unless NODE_ENV is exactly `development` or `test`:
 * staging, a preview, a typo and an unset value are all strict.
 *
 * lib/runtime-mode.test.ts fails when any other file reads NODE_ENV.
 */
export type RuntimeMode = 'development' | 'test' | 'strict'

export function runtimeMode(env: NodeJS.ProcessEnv = process.env): RuntimeMode {
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test' ? env.NODE_ENV : 'strict'
}

export const isStrict = (env: NodeJS.ProcessEnv = process.env) => runtimeMode(env) === 'strict'
export const isDevelopment = (env: NodeJS.ProcessEnv = process.env) => runtimeMode(env) === 'development'
export const isTest = (env: NodeJS.ProcessEnv = process.env) => runtimeMode(env) === 'test'

/** NODE_ENV as set, to label logs and the health output with. */
export function environmentName(env: NodeJS.ProcessEnv = process.env): string {
  return env.NODE_ENV || 'unset'
}

/**
 * Relaxations for a developer's own stack, each with the value that turns it
 * on. In strict mode none applies, and the API refuses to start with one on:
 * left in a deployed environment's config, it used to open what it relaxes
 * there (X35) or be quietly ignored.
 *
 * Not here: WEBHOOK_ALLOW_PRIVATE_URLS (lib/ssrf-guard.ts). A self-hosted
 * install may post webhooks to its own network, so it is an explicit opt-in
 * in any mode, not a development convenience.
 */
export const DEV_ONLY_FLAGS = {
  BULL_BOARD_OPEN: { on: 'true', relaxes: 'opens the Bull Board queue UI without the internal secret' },
  INBOUND_EMAIL_ALLOW_ALL: { on: '1', relaxes: 'accepts inbound email from any sender into any contract' },
} as const

export type DevOnlyFlag = keyof typeof DEV_ONLY_FLAGS

/** Whether a development-only relaxation is on: never in strict mode. */
export function devFlag(name: DevOnlyFlag, env: NodeJS.ProcessEnv = process.env): boolean {
  return !isStrict(env) && env[name] === DEV_ONLY_FLAGS[name].on
}

/** Refuse to start in strict mode with a development-only relaxation turned on. */
export function assertNoDevOnlyFlags(env: NodeJS.ProcessEnv = process.env): void {
  if (!isStrict(env)) return
  const on = (Object.keys(DEV_ONLY_FLAGS) as DevOnlyFlag[]).filter(name => env[name] === DEV_ONLY_FLAGS[name].on)
  if (on.length === 0) return
  throw new Error(
    `[runtime-mode] ${on.map(name => `${name} (${DEV_ONLY_FLAGS[name].relaxes})`).join('; ')} is for a developer's own stack, ` +
    `and NODE_ENV=${environmentName(env)} is strict. Unset it, or run with NODE_ENV=development.`,
  )
}

/** Requests per minute per client IP, across the API: tests and a developer's stack make many more. */
export function globalRateLimitPerMinute(env: NodeJS.ProcessEnv = process.env): number {
  return isStrict(env) ? 1000 : 10_000
}

/**
 * Y4 — the one scrubber every line the API prints passes.
 *
 * Secrets reached the logs four times (X3, X18, X69, X77), and each fix
 * masked one line or one logger, while about 146 console calls masked
 * nothing. Each entrypoint (index.ts, worker-entrypoint.ts) now wraps
 * process.stdout and process.stderr first thing, and everything prints
 * through them: console.*, the error reporter, and every pino logger, which
 * lib/logger.ts points at process.stdout.
 *
 * `devPrint` is the one way past it: in development, where the console is how
 * a developer receives a signing, share or invitation link, it prints the
 * line whole.
 */
import { maskTokenPaths } from './log-redact.js'

const RULES: Array<[RegExp, string]> = [
  // A private key: the whole block, in a JSON line's escaped newlines too.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:PRIVATE_KEY]'],
  // A password in a URL: scheme://user:password@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"'\\]+:)(?!\[REDACTED\])[^\s@/"'\\]+@/gi, '$1[REDACTED]@'],
  // Authorization values.
  [/\b(Bearer|Basic)\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]+/g, '$1 [REDACTED]'],
  // JWTs, wherever they are.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, '[REDACTED:JWT]'],
  // The API's own keys and webhook signing secrets.
  [/\bclm_(?:live|test)_[A-Za-z0-9_-]{16,}/g, '[REDACTED:API_KEY]'],
  [/\bwhsec_[A-Za-z0-9_-]{16,}/g, '[REDACTED:WEBHOOK_SECRET]'],
  // Model and service providers' keys: OpenAI and Anthropic, Stripe, Google,
  // Slack, GitHub, SendGrid.
  [/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|[sp]k_(?:live|test)_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35}|xox[abposr]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{36}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})/g, '[REDACTED:KEY]'],
]

// Environment variables that hold secrets: their values are masked wherever
// they appear (the internal service secret in a logged header, say). Values
// shorter than 12 characters are placeholders, or too common to mask.
const SECRET_ENV = /(?:SECRET|PASSWORD|PASS|TOKEN|API_KEY|PRIVATE_KEY|ENCRYPTION_KEY)$/

function secretValues(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => SECRET_ENV.test(name) && typeof value === 'string' && value.length >= 12)
    .map(([, value]) => value as string)
}

/**
 * The line with every secret masked: links whose path is the credential
 * (signing, share and invitation links) and credential query parameters (as
 * lib/log-redact.ts has done for request URLs), authorization values, JWTs,
 * API keys, provider keys, passwords in URLs, private keys, and the values of
 * secret environment variables. Ordinary text, and a line already masked,
 * come back as they were.
 */
export function scrub(text: string): string {
  let out = maskTokenPaths(text) as string
  for (const [rx, replacement] of RULES) out = out.replace(rx, replacement)
  for (const value of secretValues()) if (out.includes(value)) out = out.split(value).join('[REDACTED:SECRET]')
  return out
}

// A line devPrint lets through, whole: set only while it prints.
let passThrough = false

/** Scrub every chunk written to `stream` from now on. Returns the undo. */
export function scrubWrites(stream: NodeJS.WriteStream): () => void {
  const write = stream.write
  stream.write = function scrubbedWrite(this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]) {
    if (!passThrough) {
      if (typeof chunk === 'string') chunk = scrub(chunk)
      else if (chunk instanceof Uint8Array) chunk = Buffer.from(scrub(Buffer.from(chunk).toString('utf8')), 'utf8')
    }
    return (write as (...args: unknown[]) => boolean).call(stream, chunk, ...rest)
  } as typeof stream.write
  return () => { stream.write = write }
}

let installed = false

/** Scrub everything this process prints. The first thing each entrypoint does. */
export function installLogScrub(): void {
  if (installed) return
  installed = true
  scrubWrites(process.stdout)
  scrubWrites(process.stderr)
}

/**
 * Print a line on the development delivery channel: a signing, share or
 * invitation link, whole in development, where the console is how the
 * developer finds it; masked in any other mode. The one exception to the
 * scrubber, and the only one: keep it greppable.
 */
export function devPrint(line: string): void {
  if (process.env.NODE_ENV !== 'development') {
    console.info(scrub(line))
    return
  }
  passThrough = true
  try {
    console.info(line)
  } finally {
    passThrough = false
  }
}

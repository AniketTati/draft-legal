#!/usr/bin/env node
/**
 * Run the eval suite the way CI will — before pushing.
 *
 * A local run cannot tell you the things that break in CI, because your machine
 * has everything: node_modules, a generated Prisma client, a Python venv, and
 * the repo at the one absolute path your checks might have hardcoded. All three
 * of those produced a red CI run on this suite's first two attempts:
 *
 *   - the shared harness statically imported PrismaClient, so every "no
 *     services, $0" tier-1 check in fact needed `pnpm install`
 *   - thirteen checks hardcoded /Users/<someone>/... and worked on exactly one
 *     computer
 *   - one tier-1 check shelled out to apps/agents/.venv/bin/python
 *
 * Each cost a push-and-wait cycle to discover. This reproduces all of them in
 * seconds: `git archive HEAD` into a temp dir — tracked files only, no
 * node_modules, no venv, a different absolute path — and run the suite there.
 *
 *   node scripts/evals/preflight.mjs            # committed state
 *   node scripts/evals/preflight.mjs --worktree # include uncommitted changes
 *
 * Exit code is the suite's own, so this is usable as a pre-push hook.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const tier = process.argv.includes('--tier')
  ? process.argv[process.argv.indexOf('--tier') + 1] : 't1'
const useWorktree = process.argv.includes('--worktree')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-preflight-'))
try {
  // git archive gives exactly what a fresh clone gets: tracked files, nothing
  // ignored. That is the point — node_modules and .venv must NOT come along.
  const archive = spawnSync('git', ['archive', 'HEAD'], { cwd: REPO, maxBuffer: 256 * 1024 * 1024 })
  if (archive.status !== 0) {
    console.error('git archive failed:', String(archive.stderr))
    process.exit(2)
  }
  const untar = spawnSync('tar', ['-x', '-C', sandbox], { input: archive.stdout })
  if (untar.status !== 0) {
    console.error('tar failed:', String(untar.stderr))
    process.exit(2)
  }

  if (useWorktree) {
    // Overlay uncommitted edits to tracked files, so a fix can be preflighted
    // before it is committed.
    const changed = spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd: REPO, encoding: 'utf8' })
      .stdout.split('\n').filter(Boolean)
    for (const rel of changed) {
      const src = path.join(REPO, rel)
      if (!fs.existsSync(src)) continue
      fs.mkdirSync(path.dirname(path.join(sandbox, rel)), { recursive: true })
      fs.copyFileSync(src, path.join(sandbox, rel))
    }
    if (changed.length) console.log(`overlaid ${changed.length} uncommitted file(s)`)
  }

  console.log(`preflight: tier ${tier} from a clean checkout at ${sandbox}\n`)
  const run = spawnSync('node', ['scripts/evals/run.mjs', '--tier', tier, '--check-baseline'],
    { cwd: sandbox, stdio: 'inherit' })

  if (run.status !== 0) {
    console.error(`\npreflight FAILED (exit ${run.status}). This is what CI will do.`)
    console.error('A pass on your own machine does not predict this: you have node_modules,')
    console.error('a generated Prisma client, a venv, and the repo at its usual path.')
  } else {
    console.log('\npreflight OK — this is what CI will see.')
  }
  process.exit(run.status ?? 1)
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true })
}

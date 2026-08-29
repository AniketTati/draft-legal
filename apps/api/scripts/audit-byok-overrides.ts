/**
 * Pre-flight audit for the BYOK fail-closed change (docs/39 Wave 0, 0A step 2).
 *
 * READ-ONLY, always. It issues no writes and has no --fix mode, because there is
 * nothing here to fix automatically -- the output is a list of orgs a human has
 * to talk to.
 *
 * WHY THIS EXISTS. Today `router.py` falls back to the platform key whenever the
 * Node resolve fails, so an org whose tier override names a provider we hold no
 * key for is silently answered on the platform key. Their AI Config choice is a
 * no-op and nobody -- not them, not us -- is told. The moment BYOK fails closed,
 * every one of those orgs starts getting hard errors instead.
 *
 * That population is knowable in advance for the cost of one query, and it is
 * the single largest blast radius of the change. Run it against PRODUCTION, not
 * a dev database, and talk to whoever is on the list before deploying.
 *
 * Usage:
 *   cd apps/api && npx tsx --env-file=../../.env scripts/audit-byok-overrides.ts
 *   cd apps/api && npx tsx --env-file=../../.env scripts/audit-byok-overrides.ts --org=<id>
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const args = process.argv.slice(2)
const orgFilter = args.find(a => a.startsWith('--org='))?.slice('--org='.length)
  ?? args.find(a => !a.startsWith('--'))

/** Same sentinel filter aiRouter.ts applies, so this agrees with the router. */
const PLACEHOLDER = new Set(['', 'placeholder', 'REPLACE', 'TODO', 'unset'])
const realKey = (v: string | undefined): boolean =>
  typeof v === 'string' && v.length > 0 && !PLACEHOLDER.has(v)

const PLATFORM: Record<string, boolean> = {
  openai:    realKey(process.env.OPENAI_API_KEY),
  anthropic: realKey(process.env.ANTHROPIC_API_KEY),
  google:    realKey(process.env.GOOGLE_API_KEY) || realKey(process.env.GEMINI_API_KEY),
  voyage:    realKey(process.env.VOYAGE_API_KEY),
  cohere:    realKey(process.env.COHERE_API_KEY),
  mistral:   realKey(process.env.MISTRAL_API_KEY),
}

const TIERS = [
  'reasoningModel', 'defaultModel', 'fastModel',
  'embedModel', 'rerankModel', 'visionOcrModel',
] as const

async function main(): Promise<void> {
  const settings = await prisma.orgAiSettings.findMany({
    where: orgFilter ? { orgId: orgFilter } : undefined,
  })
  const byokRows = await prisma.orgAiKey.findMany({ select: { orgId: true, provider: true } })

  const byok = new Map<string, Set<string>>()
  for (const k of byokRows) {
    if (!byok.has(k.orgId)) byok.set(k.orgId, new Set())
    byok.get(k.orgId)!.add(k.provider)
  }

  const present = Object.entries(PLATFORM).filter(([, v]) => v).map(([k]) => k)
  console.log(`\nplatform keys present : ${present.join(', ') || '(none)'}`)
  console.log(`orgs with AI settings : ${settings.length}`)
  console.log(`orgs with a BYOK key  : ${byok.size}\n`)

  let overrides = 0
  const atRisk: string[] = []

  for (const s of settings) {
    const problems: string[] = []
    for (const tier of TIERS) {
      const value = s[tier]
      if (!value) continue
      overrides++
      // aiRouter.ts parses "provider/model"; a bare model has no provider to check.
      const provider = value.includes('/') ? value.split('/')[0] : null
      if (!provider) {
        problems.push(`${tier}=${value}  -> no "provider/" prefix; router cannot resolve a key`)
        continue
      }
      const hasByok = byok.get(s.orgId)?.has(provider) ?? false
      const hasPlatform = PLATFORM[provider] ?? false
      if (!hasByok && !hasPlatform) {
        problems.push(`${tier}=${value}  -> provider "${provider}" has no key (byok: no, platform: no)`)
      }
    }
    if (problems.length > 0) {
      atRisk.push(s.orgId)
      console.log(`  org ${s.orgId}`)
      for (const p of problems) console.log(`      ${p}`)
    }
  }

  const rule = '-'.repeat(66)
  console.log(`\n${rule}`)
  console.log(`tier overrides configured : ${overrides}`)
  console.log(`orgs AT RISK              : ${atRisk.length}   <- these hard-fail once BYOK fails closed`)
  console.log(rule)

  if (overrides === 0) {
    console.log('No tier overrides in this database, so the change has no blast radius here.')
    console.log('That is expected on a dev box. Re-run against production before deploying.\n')
  } else if (atRisk.length === 0) {
    console.log('Every configured override resolves to a key we hold. Safe to deploy.\n')
  } else {
    console.log('Talk to these orgs before deploying: their AI Config is silently')
    console.log('being ignored today and will start erroring after the change.\n')
  }
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())

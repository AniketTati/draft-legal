import type { CompareData } from './types'

export const spellbook: CompareData = {
  slug: 'spellbook',
  competitorName: 'Spellbook',
  competitorOneLiner:
    'AI contract drafting and review assistant that runs as a Microsoft Word add-in. Popular with corporate legal teams who live in Word.',
  tldr:
    'Spellbook is a Word add-in for AI drafting and clause review. draftLegal is a standalone Contract Lifecycle Management platform — intake, drafting, redline, approvals, signature, obligations — that you self-host under AGPL-3.0. Pick Spellbook if you want AI in your existing Word workflow. Pick draftLegal if you want one platform for the full lifecycle that your security team can audit.',
  pickDraftLegalIf: [
    'You want a full CLM, not just an AI plugin inside Word',
    'You want approvals, signatures, and obligation tracking in the same product',
    'You need to self-host the code and audit it',
    'You negotiate on the other side\'s Word file and want your redline to go back as tracked changes',
  ],
  pickCompetitorIf: [
    'Your team strongly prefers staying inside Microsoft Word for all drafting',
    'You do not need approvals, signature, or post-signature obligation tracking in one product',
    'You already have a separate contract repository and just need AI clause review',
  ],
  migration:
    'Spellbook is a drafting assistant, not a contract repository. Migration to draftLegal usually means uploading executed contracts from a DMS or drive. You can keep Spellbook for Word-side drafting if your team prefers.',
  groups: [
    {
      title: 'Product category',
      rows: [
        { label: 'Full CLM (intake → obligations)', draftLegal: 'yes', competitor: 'no' },
        { label: 'Word add-in', draftLegal: 'no', competitor: 'yes', note: 'draftLegal isn\'t an add-in, but it works on their Word file and returns tracked changes' },
        { label: 'Standalone web app', draftLegal: 'yes', competitor: 'partial' },
      ],
    },
    {
      title: 'Openness & deployment',
      rows: [
        { label: 'Open source (AGPL-3.0)', draftLegal: 'yes', competitor: 'no' },
        { label: 'Self-host on your infra', draftLegal: 'yes', competitor: 'no' },
        { label: 'Code transparency (full repo)', draftLegal: 'yes', competitor: 'no' },
      ],
    },
    {
      title: 'AI & extensibility',
      rows: [
        { label: 'Bring your own AI provider keys', draftLegal: 'yes', competitor: 'unknown' },
        { label: 'Switchable LLM provider per tier', draftLegal: 'yes', competitor: 'unknown' },
      ],
    },
  ],
}

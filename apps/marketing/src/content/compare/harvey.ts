import type { CompareData } from './types'

export const harvey: CompareData = {
  slug: 'harvey',
  competitorName: 'Harvey',
  competitorOneLiner:
    'AI legal assistant focused on legal research, drafting, and document analysis — widely adopted across BigLaw. Harvey is a vertical AI product, not a full contract lifecycle platform.',
  tldr:
    'Harvey and draftLegal solve different problems. Harvey is a legal-AI workbench primarily used by law firms for research and document work. draftLegal is a full Contract Lifecycle Management platform (intake → obligations) that you self-host, or try in our hosted demo (evaluation only). Most teams using draftLegal also use a legal-AI assistant somewhere; we focus on the contract operations layer underneath.',
  pickDraftLegalIf: [
    'You need a full CLM, not just an AI assistant — intake, drafting, approvals, signature, obligations',
    'You want to self-host the platform under AGPL-3.0 and audit the code',
    'You want one open codebase covering the whole lifecycle',
  ],
  pickCompetitorIf: [
    'You are primarily a law firm and your main use case is research + memo drafting',
    'You need deep BigLaw-tuned workflows on top of your existing DMS',
    'Your team already standardised on Harvey as your AI legal workbench',
  ],
  migration:
    'Harvey is generally a side-by-side workbench, not a system of record for contracts. If you are moving your contract operations into draftLegal, you migrate from your contract repository (DMS, SharePoint, drive) by uploading the files, rather than from Harvey itself.',
  groups: [
    {
      title: 'Product category',
      rows: [
        { label: 'Full CLM (intake → obligations)', draftLegal: 'yes', competitor: 'no', note: 'Harvey is an AI assistant, not a CLM' },
        { label: 'AI legal assistant', draftLegal: 'partial', competitor: 'yes', note: 'draftLegal has an assistant but is not a research workbench' },
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

/** docs/41 Part 19 — the decision-led Analytics sections, rendered to a string from seeded query data. */
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DecisionAnalytics, DEFAULT_FILTERS, drillHref, filterQuery, sectionKey, type SectionPart } from './DecisionSections'

const NOW = Date.UTC(2026, 9, 2)
const bar = (key: string, label: string, value: number, n = 1, extra?: Record<string, number | string | null>) => ({ key, label, value, n, ...(extra && { extra }) })
const P = (headline: SectionPart['headline'], charts: SectionPart['charts'], available?: boolean): SectionPart => ({ headline, charts, ...(available != null && { available }) })

const DATA: Record<string, Record<string, SectionPart>> = {
  speed: {
    cycle: P({ executed: 3, medianDays: 12.5, p90Days: 40 }, { byType: [bar('NDA', 'NDA', 5, 2)], byPaper: [bar('ours', 'Our paper', 4)], byOwner: [] }),
    templates: P({ templates: 1 }, { byTemplate: [bar('t1', 'Mutual NDA', 2, 2, { medianCycleDays: 4, medianTurns: 1 })] }),
  },
  bottlenecks: {
    stages: P({ bottleneck: 'approve', bottleneckLabel: 'Approve', bottleneckMedianDays: 8 }, { byStage: [bar('approve', 'Approve', 8, 2, { inStageNow: 1 })] }),
    approvals: P({ medianDays: 1.5, waitingNow: 2 }, { byApprover: [bar('u1', 'Priya Approver', 1.5)], byStep: [] }),
  },
  workload: { mine: P({ waiting: 4, over14Days: 1 }, { byAge: [bar('0-2', 'Under 3 days', 3, 3)], byHolder: [] }) },
  negotiation: {
    turns: P({ turnaroundMedianDays: 5, turnsReturned: 3, withCounterpartyNow: 1, medianTurnsPerContract: 2 }, { byCounterparty: [bar('acme', 'Acme', 5)], turnsPerContract: [] }),
    clauses: P({}, { byClause: [bar('limitation_of_liability', 'Limitation of liability', 3, 3, { countered: 2, exception: 1, accepted: 0 })] }),
  },
  risk: {
    adherence: P({ rate: 0.75, adherent: 3, reviewed: 4 }, { atSignature: [bar('adherent', 'Within the playbook', 3, 3)], openByClause: [] }),
    exceptions: P({ requested: 2, granted: 1, grantRate: 0.5 }, { byClause: [], byApprover: [] }),
  },
  renewals: { renewals: P({ upcoming: 2, missed: 1, deadlinesPassed: 3, missedAutoRenewing: 1 }, { upcoming: [bar('0-30', 'Next 30 days', 2, 2)], outcome: [] }) },
  ai: { acceptance: P({}, { byFeature: [] }, false) },
}

function render() {
  const qc = new QueryClient()
  const query = filterQuery(DEFAULT_FILTERS, null)
  for (const [name, parts] of Object.entries(DATA)) qc.setQueryData(sectionKey(name, query), { section: name, parts })
  return renderToString(
    <QueryClientProvider client={qc}><MemoryRouter><DecisionAnalytics /></MemoryRouter></QueryClientProvider>,
  ).replace(/<!-- -->/g, '')
}

describe('DecisionAnalytics', () => {
  it('renders a section per decision, each with its question and a CSV download', () => {
    const html = render()
    for (const s of ['speed', 'bottlenecks', 'workload', 'negotiation', 'risk', 'renewals', 'ai']) {
      expect(html).toContain(`data-testid="analytics-section-${s}"`)
      expect(html).toContain(`data-testid="analytics-csv-${s}"`)
    }
    for (const t of ['Speed', 'Bottlenecks', 'Workload', 'Negotiation', 'Risk and playbook', 'Renewals', 'AI suggestions']) expect(html).toContain(`>${t}</h2>`)
  })

  it('shows the headline figures and says what each chart helps decide', () => {
    const html = render()
    expect(html).toContain('13 d')                     // median cycle time, whole days from 10 up
    expect(html).toContain('>Approve<')                // the bottleneck
    expect(html).toContain('75%')                      // adherence
    expect(html).toContain('Which stage to fix first')
    expect(html).toContain('Which template wording or position to change')
    expect(html).toContain('Limitation of liability')
    expect(html).toContain('Suggestion outcomes aren’t recorded yet')
  })

  it('links each bar to its contracts with the section filters', () => {
    const html = render()
    const href = drillHref('negotiation.clauses.byClause', bar('limitation_of_liability', 'Limitation of liability', 3), filterQuery(DEFAULT_FILTERS, null))
    expect(html).toContain(href.replace(/&/g, '&amp;'))
    const q = new URLSearchParams(href.split('?')[1])
    expect(q.get('drill')).toBe('negotiation.clauses.byClause')
    expect(q.get('drillKey')).toBe('limitation_of_liability')
    expect(new URLSearchParams(q.get('dq')!).get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('filterQuery', () => {
  it('sends the period start, type, owner and paper', () => {
    expect(filterQuery({ days: 30, type: 'NDA', mine: true, paperSource: 'ours' }, 'u1', NOW)).toBe('from=2026-09-02&type=NDA&ownerId=u1&paperSource=ours')
    expect(filterQuery({ ...DEFAULT_FILTERS, mine: true }, null, NOW)).toBe('from=2026-04-05')
  })
})

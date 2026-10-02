/**
 * docs/41 browser QA — a failed analysis says the step and why in words,
 * with Retry, never the stored error's JSON. Rendered to a string.
 */
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AnalysisFailedBanner } from './AnalysisFailedBanner'
import { plainFailure, failureLine } from '@/lib/analysis-state'

const RAW = 'Failed while saving what was read (attempt 3 of 3): the contract\'s fields were refused (422): {"type":"about:blank","title":"Unprocessable Entity","status":422,"detail":"effectiveDate must be a date"}'

describe('why an analysis failed', () => {
  it('is said in words, whatever the stored error holds', () => {
    expect(plainFailure(RAW)).toBe('What it read couldn’t be saved.')
    expect(plainFailure('Failed while reading its fields and clauses (attempt 1 of 3): the extraction service answered 503: upstream down')).toBe('The AI service couldn’t be reached.')
    expect(plainFailure('Failed while reading its fields and clauses (attempt 2 of 3): model timed out')).toBe('The AI service took too long to answer.')
    expect(plainFailure('No clauses found in the document')).toBe('No clauses were found in the document.')
    expect(plainFailure('TypeError: Cannot read properties of undefined (reading \'x\')')).toBe('Something went wrong on our side.')
    expect(plainFailure('the document was empty')).toBe('The document was empty.')
    expect(plainFailure(null)).toBeNull()
  })

  it('takes the step from the run, else from the stored error', () => {
    expect(failureLine({ failedStepLabel: 'finding and indexing its clauses', error: 'No clauses found' }, RAW))
      .toEqual({ title: 'Analysis failed while finding and indexing its clauses', reason: 'No clauses were found in the document.' })
    expect(failureLine(null, RAW)).toEqual({ title: 'Analysis failed while saving what was read', reason: 'What it read couldn’t be saved.' })
  })
})

describe('the failed-analysis banner', () => {
  const html = (draftFailed = false) => renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <AnalysisFailedBanner contractId="k1" analysisError={RAW} draftFailed={draftFailed} onRetry={() => {}} retrying={false} />
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '').replace(/&#x27;/g, "'")

  it('says the step and why, offers Retry, and shows no JSON or status code', () => {
    const out = html()
    expect(out).toContain('Analysis failed while saving what was read.')
    expect(out).toContain('What it read couldn’t be saved.')
    expect(out).toMatch(/data-testid="analysis-retry"[^>]*>Retry</)
    expect(out).not.toMatch(/422|about:blank|\{&quot;|attempt 3 of 3/)
  })

  it('a draft that failed offers to retry the draft', () => {
    expect(html(true)).toContain('Draft generation failed')
    expect(html(true)).toContain('Retry draft')
  })
})

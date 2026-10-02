/**
 * docs/41 browser QA — a failed analysis, said plainly: the step it stopped
 * at (from its run), why in words, and Retry. The banner used to show the
 * stored error as it was: "— Failed while saving what was read (attempt 3 of
 * 3): the contract's fields were refused (422): {"type":…}".
 */
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { failureLine } from '@/lib/analysis-state'
import { Button } from '@/components/ui/button'

interface RunRow { status: string; failedStepLabel: string | null; error: string | null }

export function AnalysisFailedBanner({ contractId, analysisError, draftFailed, onRetry, retrying }: {
  contractId: string
  analysisError: string | null | undefined
  /** No version was made: the draft itself failed. */
  draftFailed: boolean
  onRetry: () => void
  retrying: boolean
}) {
  const runs = useQuery({
    queryKey: ['contract-analysis-runs', contractId],
    queryFn: () => api.get<{ data: RunRow[] }>(`/contracts/${contractId}/analysis-runs`).then(r => r.data.data),
    enabled: !draftFailed,
    staleTime: 30_000,
  })
  const run = runs.data?.find(r => r.status === 'failed') ?? null
  const line = failureLine(run, analysisError)
  return (
    <div className="bg-risk-50 border-b border-risk-200 text-risk-700 px-6 py-2.5 flex items-center gap-3 text-body" data-testid="analysis-failed-banner">
      <AlertCircle className="size-4 flex-shrink-0" />
      <span className="font-medium flex-shrink-0">{draftFailed ? 'Draft generation failed' : `${line.title}.`}</span>
      {line.reason && <span className="text-risk-900 min-w-0" data-testid="analysis-error">{line.reason}</span>}
      <div className="ml-auto">
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={retrying}
          className="gap-1.5 text-risk-700 border-risk-200 hover:bg-risk-100 hover:text-risk-900"
          data-testid="analysis-retry"
        >
          {retrying && <Loader2 className="size-3.5 animate-spin" />}
          {draftFailed ? 'Retry draft' : 'Retry'}
        </Button>
      </div>
    </div>
  )
}

/**
 * NotFoundPage — the catch-all for unrecognised routes.
 *
 * Until this existed the router had ~35 concrete children and no `path="*"`,
 * so any URL that missed them all rendered AppShell's <Outlet/> as null: full
 * navigation chrome wrapped around an empty page. That is worse than a 404,
 * because a blank page reads as a broken APP rather than a bad link — and it is
 * undiagnosable from the outside, which is how a dead notification link went
 * unnoticed.
 */
import { useLocation, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Compass, ArrowLeft } from 'lucide-react'

export function NotFoundPage() {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  return (
    <div className="flex flex-col items-center justify-center py-24 text-center" data-testid="not-found">
      <Compass className="size-6 text-ink-400" />
      <h1 className="mt-3 text-title text-ink-950">This page doesn’t exist</h1>
      {/* Show the path. A user reporting "it's blank" is unactionable; a user
          reporting "/approvals/abc123 says it doesn't exist" is a bug report. */}
      <p className="mt-1 text-body text-ink-500">
        Nothing is routed at{' '}
        <code className="rounded-chip bg-paper-100 px-1.5 py-0.5 font-mono text-[12px] text-ink-700">{pathname}</code>
      </p>
      <div className="mt-5 flex items-center gap-2">
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => navigate(-1)}>
          <ArrowLeft className="size-3.5" /> Go back
        </Button>
        <Button size="sm" onClick={() => navigate('/dashboard')}>Go to dashboard</Button>
      </div>
    </div>
  )
}

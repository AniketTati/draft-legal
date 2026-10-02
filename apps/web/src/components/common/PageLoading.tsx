import { Loader2 } from 'lucide-react'

/** Shown while a page's code loads on first visit (pages load on demand: App.tsx). */
export function PageLoading() {
  return (
    <div className="flex h-full min-h-[40vh] items-center justify-center text-ink-500" role="status" aria-label="Loading">
      <Loader2 className="size-5 animate-spin" />
    </div>
  )
}

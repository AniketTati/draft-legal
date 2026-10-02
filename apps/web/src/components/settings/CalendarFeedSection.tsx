/**
 * docs/41 Part 14 — "Calendar feed": a private link the person's calendar app
 * subscribes to, with notice deadlines, end dates and obligation due dates for
 * the contracts they can see. The link is shown once, when made; making a new
 * one or turning it off stops the old one working.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, Check, Copy, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'

interface FeedStatus { active: boolean; createdAt: string | null; revokedAt: string | null }

const KEY = ['calendar-feed'] as const
const day = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

export function CalendarFeedSection() {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: KEY, queryFn: async () => (await api.get<FeedStatus>('/calendar-feed')).data })
  const [url, setUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const create = useMutation({
    mutationFn: async () => (await api.post<FeedStatus & { url: string }>('/calendar-feed')).data,
    onSuccess: r => { setUrl(r.url); setCopied(false); void qc.invalidateQueries({ queryKey: KEY }) },
  })
  const revoke = useMutation({
    mutationFn: async () => (await api.delete<FeedStatus>('/calendar-feed')).data,
    onSuccess: () => { setUrl(null); void qc.invalidateQueries({ queryKey: KEY }) },
  })
  const copy = async () => {
    if (!url) return
    try { await navigator.clipboard.writeText(url); setCopied(true) } catch { setCopied(false) }
  }

  const active = status.data?.active ?? false
  return (
    <section className="bg-card rounded-card border border-paper-200 p-4 space-y-3" data-testid="calendar-feed-section">
      <div className="flex items-center gap-2">
        <CalendarDays className="size-4 text-ink-500" />
        <h2 className="text-section text-ink-950">Calendar feed</h2>
      </div>
      <p className="text-dense text-ink-500">
        Add your contract dates to Google Calendar, Outlook or Apple Calendar: the last day to give notice, when each
        contract ends, and when obligations are due, for the contracts you can see. Anyone with the link can see these
        dates, so keep it to yourself.
      </p>

      {url && (
        <div className="space-y-1.5" data-testid="calendar-feed-url">
          <p className="text-dense text-ink-700">Copy this link now and subscribe to it in your calendar app. It won’t be shown again.</p>
          <div className="flex gap-2">
            <input readOnly value={url} onFocus={e => e.currentTarget.select()} aria-label="Calendar feed link"
              className="flex-1 min-w-0 rounded-md border border-input bg-paper-50 px-2 py-1.5 text-[12px] font-mono text-ink-700" />
            <Button size="sm" variant="outline" onClick={copy} data-testid="calendar-feed-copy">
              {copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      )}

      {!url && active && status.data?.createdAt && (
        <p className="text-dense text-ink-700" data-testid="calendar-feed-active">Your link has been on since {day(status.data.createdAt)}.</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={active ? 'outline' : 'default'} disabled={create.isPending || status.isLoading}
          onClick={() => create.mutate()} data-testid="calendar-feed-create">
          {create.isPending && <Loader2 className="animate-spin" />}
          {active ? 'Make a new link' : 'Make my link'}
        </Button>
        {active && (
          <Button size="sm" variant="outline" disabled={revoke.isPending} onClick={() => revoke.mutate()} data-testid="calendar-feed-revoke">
            Turn off the link
          </Button>
        )}
      </div>
      {active && !url && <p className="text-[11px] text-ink-500">A new link stops the old one working.</p>}
      {(create.isError || revoke.isError) && <p className="text-dense text-risk-700" role="alert">That didn’t work. Try again.</p>}
    </section>
  )
}

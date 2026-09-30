import { agents } from '@/content/agents'
import { cn } from '@/lib/utils'

export function AgentGrid({ compact = false }: { compact?: boolean }) {
  return (
    <section className="bg-slate-50 py-20 md:py-28">
      <div className="container-page">
        <div className="mx-auto max-w-3xl text-center">
          <div className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
            The agents
          </div>
          <h2 className="mt-3 heading-section text-slate-900">
            12 specialized agents do the work.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-slate-600">
            Each agent is built for a specific job in the contract lifecycle. They run on Anthropic,
            OpenAI, Google or OpenRouter models, chosen per tier for your organisation. Every change
            the assistant proposes waits for your confirmation.
          </p>
        </div>

        <ul
          className={cn(
            'mx-auto mt-14 grid gap-px overflow-hidden rounded-2xl border border-slate-200 bg-slate-200',
            compact
              ? 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4'
              : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
          )}
        >
          {agents.map((a) => (
            <li
              key={a.slug}
              className="flex flex-col gap-1.5 bg-white p-5 transition-colors hover:bg-slate-50"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-900">{a.name}</span>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                    a.status === 'live'
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-slate-100 text-slate-500'
                  )}
                >
                  {a.status === 'live' ? 'Live' : 'Soon'}
                </span>
              </div>
              <div className="text-xs font-medium text-emerald-700">{a.blurb}</div>
              <p className="text-sm leading-6 text-slate-600">{a.capability}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

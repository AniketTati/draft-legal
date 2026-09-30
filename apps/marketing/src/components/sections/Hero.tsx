import { Link } from 'react-router-dom'
import { Github, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { APP_URL, GITHUB_URL } from '@/lib/utils'

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden bg-white">
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[radial-gradient(70%_60%_at_50%_-10%,rgba(16,185,129,0.12),transparent_60%)]"
      />
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 -z-10 h-px bg-gradient-to-r from-transparent via-emerald-600/40 to-transparent"
      />
      <div className="container-page py-20 md:py-28">
        <Link
          to="/open-source"
          className="mx-auto inline-flex w-fit items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800 transition-colors hover:border-emerald-300 hover:bg-emerald-100"
        >
          <span className="grid h-1.5 w-1.5 place-items-center">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-600" />
          </span>
          Open source · read the code →
        </Link>

        <h1 className="mx-auto mt-8 max-w-4xl text-center text-5xl font-bold tracking-tight text-slate-900 sm:text-6xl lg:text-7xl">
          Open-source,{' '}
          <span className="bg-gradient-to-br from-emerald-700 to-emerald-500 bg-clip-text text-transparent">
            agent-first
          </span>{' '}
          CLM.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-center text-lg leading-8 text-slate-600 sm:text-xl">
          12 AI agents handle intake, review, drafting, negotiation, approvals and obligations,
          with e-signature built in — across the full contract lifecycle.{' '}
          <span className="text-slate-900">
            AGPL-3.0 licensed, self-host the same code we run.
          </span>
        </p>

        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button asChild size="lg" variant="outline">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              <Github className="mr-2 h-4 w-4" />
              Self-host on GitHub
            </a>
          </Button>
          <Button asChild size="lg" variant="ghost">
            <a href={`${APP_URL}/register`}>
              Try the public demo <ArrowRight className="ml-1.5 h-4 w-4" />
            </a>
          </Button>
        </div>
        <p className="mt-3 text-center text-xs text-slate-500">
          Demo runs on free-tier infrastructure — evaluation only, not for production data.
        </p>

        <div className="mx-auto mt-12 grid max-w-3xl grid-cols-3 gap-6 border-t border-slate-200 pt-10 text-center">
          <div>
            <div className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">12</div>
            <div className="mt-1 text-sm text-slate-600">specialized AI agents</div>
          </div>
          <div className="border-x border-slate-200">
            <div className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">6</div>
            <div className="mt-1 text-sm text-slate-600">lifecycle stages</div>
          </div>
          <div>
            <div className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">1</div>
            <div className="mt-1 text-sm text-slate-600">platform, AGPL-3.0 licensed</div>
          </div>
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-slate-500">
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            AGPL-3.0 licensed
          </span>
          <span>·</span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Bring your own AI keys
          </span>
          <span>·</span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            No vendor lock-in
          </span>
        </div>
      </div>
    </section>
  )
}

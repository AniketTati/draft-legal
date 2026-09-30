import { Github, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { APP_URL, GITHUB_URL } from '@/lib/utils'

export function CtaStrip({
  eyebrow = 'Ready when you are',
  title = 'Ship your first contract in minutes.',
  subtitle = 'Self-host it in 3 commands, or try the hosted demo (evaluation only).',
}: {
  eyebrow?: string
  title?: string
  subtitle?: string
}) {
  return (
    <section className="relative isolate overflow-hidden bg-emerald-700 py-20 text-white md:py-24">
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[radial-gradient(70%_60%_at_50%_0%,rgba(16,185,129,0.5),transparent_60%)]"
      />
      <div className="container-page text-center">
        <div className="text-xs font-semibold uppercase tracking-wide text-emerald-200">
          {eyebrow}
        </div>
        <h2 className="mx-auto mt-3 max-w-3xl text-3xl font-bold tracking-tight sm:text-4xl">
          {title}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-emerald-100">{subtitle}</p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button asChild size="lg" variant="light">
            <a href={`${APP_URL}/register`}>
              Start free <ArrowRight className="ml-1.5 h-4 w-4" />
            </a>
          </Button>
          <Button
            asChild
            size="lg"
            className="border border-emerald-500 bg-transparent text-white hover:bg-emerald-800"
          >
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              <Github className="mr-2 h-4 w-4" />
              View on GitHub
            </a>
          </Button>
        </div>
      </div>
    </section>
  )
}

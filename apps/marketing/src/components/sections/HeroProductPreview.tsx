import { BrowserFrame } from './BrowserFrame'

export function HeroProductPreview() {
  return (
    <section className="relative -mt-6 bg-white pb-20 md:pb-28">
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 -z-10 h-1/2 bg-gradient-to-b from-emerald-50/40 to-white"
      />
      <div className="container-page">
        <div className="relative mx-auto max-w-6xl">
          <BrowserFrame
            src="/product/dashboard.png"
            alt="Draft Legal dashboard — pending approvals, recent activity, and the AI assistant"
            shadow="lifted"
            url="app.draft-legal.com/dashboard"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-white via-white/80 to-transparent"
          />
        </div>
        <p className="mx-auto mt-6 max-w-2xl text-center text-xs text-slate-500">
          Screenshot from the product. The Assistant panel on the right answers from your
          contracts and cites the ones it used.
        </p>
      </div>
    </section>
  )
}

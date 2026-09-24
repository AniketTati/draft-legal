import { Link, NavLink } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { Menu, X, Github } from 'lucide-react'
import { Logo } from './Logo'
import { Button } from '@/components/ui/button'
import { APP_URL, GITHUB_URL, cn } from '@/lib/utils'
import { compareSlugs, learnSlugs, industrySlugs } from '@/lib/routes'

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'text-sm font-medium transition-colors',
    isActive ? 'text-emerald-700' : 'text-slate-700 hover:text-slate-900'
  )

const MegaItem = ({ to, label, blurb }: { to: string; label: string; blurb?: string }) => (
  <Link
    to={to}
    className="group block rounded-md p-3 transition-colors hover:bg-slate-50"
  >
    <div className="text-sm font-semibold text-slate-900 group-hover:text-emerald-700">
      {label}
    </div>
    {blurb && <div className="mt-0.5 text-xs text-slate-500">{blurb}</div>}
  </Link>
)

const titleCase = (s: string) =>
  s
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/Nda|Msa|Dpa|Baa|Sow|Mta/g, (m) => m.toUpperCase())

export function Nav() {
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header
      className={cn(
        'sticky top-0 z-40 w-full border-b transition-all',
        scrolled
          ? 'border-slate-200 bg-white/90 backdrop-blur'
          : 'border-transparent bg-white'
      )}
    >
      <div className="container-page flex h-16 items-center justify-between gap-4">
        <Logo />

        <nav className="hidden items-center gap-7 md:flex">
          <NavLink to="/product" className={linkClass}>
            Product
          </NavLink>

          <div className="group relative">
            <button className="flex items-center gap-1 text-sm font-medium text-slate-700 hover:text-slate-900">
              Solutions
            </button>
            <div className="invisible absolute left-1/2 top-full z-50 w-[640px] -translate-x-1/2 pt-3 opacity-0 transition-all group-hover:visible group-hover:opacity-100">
              <div className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
                <div>
                  <div className="px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    By industry
                  </div>
                  {industrySlugs.map((s) => (
                    <MegaItem key={s} to={`/industries/${s}`} label={`CLM for ${titleCase(s)}`} />
                  ))}
                </div>
                <div>
                  <div className="px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Compare
                  </div>
                  {compareSlugs.map((s) => (
                    <MegaItem
                      key={s}
                      to={`/compare/${s}`}
                      label={`vs ${titleCase(s.replace('docusign-clm', 'DocuSign CLM'))}`}
                    />
                  ))}
                  <MegaItem to="/alternatives" label="All alternatives →" />
                </div>
              </div>
            </div>
          </div>

          <div className="group relative">
            <button className="flex items-center gap-1 text-sm font-medium text-slate-700 hover:text-slate-900">
              Resources
            </button>
            <div className="invisible absolute left-1/2 top-full z-50 w-[480px] -translate-x-1/2 pt-3 opacity-0 transition-all group-hover:visible group-hover:opacity-100">
              <div className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
                <div>
                  <div className="px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Learn
                  </div>
                  {learnSlugs.slice(0, 6).map((s) => (
                    <MegaItem key={s} to={`/learn/${s}`} label={titleCase(s)} />
                  ))}
                  <MegaItem to="/learn" label="All articles →" />
                </div>
                <div>
                  <div className="px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Template guides
                  </div>
                  <MegaItem to="/templates/nda" label="NDA guide" blurb="Mutual or one-way" />
                  <MegaItem to="/templates/msa" label="MSA guide" blurb="B2B SaaS / services" />
                  <MegaItem to="/templates/dpa" label="DPA guide" blurb="GDPR-aligned" />
                  <MegaItem to="/templates" label="All template guides →" />
                </div>
              </div>
            </div>
          </div>

          <NavLink to="/pricing" className={linkClass}>
            Pricing
          </NavLink>
          <NavLink to="/open-source" className={linkClass}>
            Open Source
          </NavLink>
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          >
            <Github className="h-4 w-4" />
          </a>
          <Button asChild size="sm" variant="ghost">
            <Link to="/contact">Contact</Link>
          </Button>
          <Button asChild size="sm">
            <a href={`${APP_URL}/register`}>Start free →</a>
          </Button>
        </div>

        <button
          className="inline-flex h-10 w-10 items-center justify-center rounded-md text-slate-700 md:hidden"
          aria-label="Toggle menu"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {open && (
        <div className="border-t border-slate-200 bg-white md:hidden">
          <div className="container-page space-y-1 py-4">
            {[
              ['Product', '/product'],
              ['Pricing', '/pricing'],
              ['Open Source', '/open-source'],
              ['Compare', '/alternatives'],
              ['Learn', '/learn'],
              ['Templates', '/templates'],
              ['Industries', '/industries'],
              ['Security', '/security'],
              ['Contact', '/contact'],
            ].map(([label, href]) => (
              <Link
                key={href}
                to={href}
                onClick={() => setOpen(false)}
                className="block rounded-md px-3 py-2 text-base font-medium text-slate-800 hover:bg-slate-50"
              >
                {label}
              </Link>
            ))}
            <div className="flex gap-2 pt-3">
              <Button asChild className="flex-1">
                <a href={`${APP_URL}/register`}>Start free →</a>
              </Button>
              <Button asChild variant="outline" aria-label="GitHub">
                <a href={GITHUB_URL} target="_blank" rel="noreferrer">
                  <Github className="h-4 w-4" />
                </a>
              </Button>
            </div>
          </div>
        </div>
      )}
    </header>
  )
}

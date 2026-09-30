import { Link } from 'react-router-dom'
import { Github } from 'lucide-react'
import { Logo } from './Logo'
import { APP_URL, GITHUB_URL } from '@/lib/utils'

const cols = [
  {
    title: 'Product',
    links: [
      ['Product tour', '/product'],
      ['Pricing', '/pricing'],
      ['Security', '/security'],
      ['Open Source', '/open-source'],
    ],
  },
  {
    title: 'Solutions',
    links: [
      ['SaaS', '/industries/saas'],
      ['Healthcare', '/industries/healthcare'],
      ['Manufacturing', '/industries/manufacturing'],
      ['Biotech', '/industries/biotech'],
      ['Logistics', '/industries/logistics'],
    ],
  },
  {
    title: 'Compare',
    links: [
      ['vs Ironclad', '/compare/ironclad'],
      ['vs Harvey', '/compare/harvey'],
      ['vs Spellbook', '/compare/spellbook'],
      ['vs DocuSign CLM', '/compare/docusign-clm'],
      ['vs Icertis', '/compare/icertis'],
      ['All alternatives', '/alternatives'],
    ],
  },
  {
    title: 'Resources',
    links: [
      ['Learn', '/learn'],
      ['Template guides', '/templates'],
      ['Contact', '/contact'],
    ],
  },
]

export function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-slate-50">
      <div className="container-page py-16">
        <div className="grid grid-cols-2 gap-10 md:grid-cols-6">
          <div className="col-span-2">
            <Logo />
            <p className="mt-4 max-w-xs text-sm leading-6 text-slate-600">
              Open-source, agent-first contract lifecycle management. Self-host it, or try the
              hosted demo (evaluation only).
            </p>
            <div className="mt-5 flex items-center gap-3 text-slate-500">
              <a href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label="GitHub" className="hover:text-slate-900">
                <Github className="h-5 w-5" />
              </a>
            </div>
          </div>
          {cols.map((col) => (
            <div key={col.title}>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {col.title}
              </div>
              <ul className="mt-4 space-y-2.5">
                {col.links.map(([label, href]) => (
                  <li key={href}>
                    <Link to={href} className="text-sm text-slate-700 hover:text-emerald-700">
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-12 flex flex-col items-start justify-between gap-4 border-t border-slate-200 pt-8 text-xs text-slate-500 md:flex-row md:items-center">
          <div>© {new Date().getFullYear()} Draft Legal. AGPL-3.0 licensed open source.</div>
          <div className="flex gap-5">
            <a href={`${APP_URL}/privacy`}>Privacy</a>
            <a href={`${APP_URL}/terms`}>Terms</a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </div>
        </div>
      </div>
    </footer>
  )
}

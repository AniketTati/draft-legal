import { Lock, ShieldCheck, FileSearch, KeyRound, ScrollText, Database } from 'lucide-react'
import { Link } from 'react-router-dom'

const items = [
  { icon: Lock, label: 'Encryption at rest & in transit' },
  { icon: ShieldCheck, label: 'RBAC with action × resource × scope' },
  { icon: FileSearch, label: 'Append-only audit log' },
  { icon: KeyRound, label: 'JWT (HS256) sessions · SSO on the roadmap' },
  { icon: ScrollText, label: 'AI plans gated by human approval' },
  { icon: Database, label: 'Postgres row-level isolation' },
]

export function TrustStrip() {
  return (
    <section className="border-y border-slate-200 bg-white py-14">
      <div className="container-page">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Built for legal-grade trust
          </div>
          <Link
            to="/security"
            className="text-sm font-medium text-emerald-700 hover:text-emerald-800"
          >
            Read the security page →
          </Link>
        </div>
        <ul className="mt-8 grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3 lg:grid-cols-6">
          {items.map(({ icon: Icon, label }) => (
            <li key={label} className="flex items-center gap-2.5 text-sm text-slate-700">
              <span className="grid h-9 w-9 place-items-center rounded-md bg-emerald-50 text-emerald-700">
                <Icon className="h-4 w-4" />
              </span>
              <span className="text-xs font-medium leading-tight">{label}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

import { Link } from 'react-router-dom'
import { Check, X, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'

// Only rows that are publicly verifiable from each vendor's own documentation
// or open-standards status. No claims about pricing tiers, implementation
// time, or anything that varies by deal — we cannot verify those.
const cols = ['draftLegal', 'Ironclad', 'Harvey', 'Spellbook'] as const

const rows: { label: string; values: ('yes' | 'no' | 'partial' | string)[] }[] = [
  { label: 'Open source (AGPL-3.0)',                values: ['yes', 'no', 'no', 'no'] },
  { label: 'Self-host on your infra',          values: ['yes', 'no', 'no', 'no'] },
  { label: 'Code transparency (full repo)',    values: ['yes', 'no', 'no', 'no'] },
  { label: 'Full CLM (intake → obligations)',  values: ['yes', 'yes', 'no', 'no'] },
  { label: 'Pricing published on website',     values: ['yes', 'no', 'no', 'yes'] },
  { label: 'Free self-host tier',              values: ['yes', 'no', 'no', 'no'] },
]

const Cell = ({ v }: { v: string }) => {
  if (v === 'yes')
    return (
      <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
        <Check className="h-4 w-4" strokeWidth={2.5} />
      </span>
    )
  if (v === 'no')
    return (
      <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-rose-50 text-rose-600">
        <X className="h-4 w-4" strokeWidth={2.5} />
      </span>
    )
  if (v === 'partial')
    return (
      <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-amber-50 text-amber-700">
        <Minus className="h-4 w-4" strokeWidth={2.5} />
      </span>
    )
  return <span className="font-mono text-xs text-slate-700">{v}</span>
}

export function CompareTeaser() {
  return (
    <section className="bg-white py-20 md:py-24">
      <div className="container-page">
        <div className="mx-auto max-w-3xl text-center">
          <div className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
            How we compare
          </div>
          <h2 className="mt-3 heading-section text-slate-900">
            Quick honest comparison.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-slate-600">
            We don't claim to win every dimension. We do think the open-source path matters for
            most legal teams.
          </p>
        </div>

        <div className="mx-auto mt-10 max-w-4xl overflow-hidden rounded-xl border border-slate-200">
          <table className="w-full">
            <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-3 text-left">Capability</th>
                {cols.map((c) => (
                  <th
                    key={c}
                    className={cn(
                      'px-5 py-3 text-center',
                      c === 'draftLegal' && 'bg-emerald-50 text-emerald-800'
                    )}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white text-sm">
              {rows.map((r) => (
                <tr key={r.label}>
                  <td className="px-5 py-4 font-medium text-slate-800">{r.label}</td>
                  {r.values.map((v, i) => (
                    <td
                      key={i}
                      className={cn(
                        'px-5 py-4 text-center',
                        i === 0 && 'bg-emerald-50/60'
                      )}
                    >
                      <Cell v={v} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/compare/ironclad"
            className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50"
          >
            vs Ironclad →
          </Link>
          <Link
            to="/compare/harvey"
            className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50"
          >
            vs Harvey →
          </Link>
          <Link
            to="/compare/spellbook"
            className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50"
          >
            vs Spellbook →
          </Link>
          <Link
            to="/alternatives"
            className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
          >
            See all comparisons →
          </Link>
        </div>
      </div>
    </section>
  )
}

/**
 * Wordmark — the draftLegal brand wordmark.
 *
 *   draft   slate-600 / semibold — graphite pencil gray, the
 *                                  "work-in-progress" half
 *   Legal   emerald-700 / bold   — authoritative, the
 *                                  "signed and final" half
 *
 * The color split is the brand: drafts (gray, in-flux) become legally
 * binding (green, final). Same component used in the sidebar, login
 * page, invite page — anywhere the brand needs to render.
 *
 * `kind="full"` shows "draftLegal"; `kind="mark"` shows just "dL"
 * for the collapsed sidebar.
 */
import { cn } from '@/lib/utils'

type Size = 'sm' | 'md' | 'lg' | 'xl' | '2xl'

const SIZE: Record<Size, string> = {
  sm:    'text-sm',
  md:    'text-base',
  lg:    'text-lg',
  xl:    'text-xl',
  '2xl': 'text-2xl',
}

export function Wordmark({
  size = 'md',
  kind = 'full',
  className,
}: {
  size?:      Size
  kind?:      'full' | 'mark'
  className?: string
}) {
  const draft = kind === 'full' ? 'draft' : 'd'
  const legal = kind === 'full' ? 'Legal' : 'L'
  return (
    <span
      className={cn('inline-flex tracking-tight select-none', SIZE[size], className)}
      aria-label="draftLegal"
    >
      {/* Weight contrast (medium → bold) reinforces "tentative → committed".
          ink-700 reads as pencil on paper; brand-700 carries the authority.
          Together: "drafts become legally binding". This is the one place the
          brand color appears as identity rather than as the meaning "binding". */}
      <span className="font-medium text-ink-700">{draft}</span>
      <span className="font-bold text-brand-700">{legal}</span>
    </span>
  )
}

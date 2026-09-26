/**
 * Z2 — installing an industry pack after onboarding. The first-login wizard
 * says "you can install one later from Settings", and the dashboard checklist
 * links here, but nothing here installed one. It uses the wizard's endpoint,
 * which records what was installed, so the checklist ticks as well.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Briefcase, CheckCircle2, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/common/Toaster'

interface Pack { id: string; label: string; description: string }

/** The one install endpoint, shared with the onboarding wizard. */
export const INSTALL_PACK_PATH = '/organization/install-industry-pack'

export function IndustryPacksTab() {
  const qc = useQueryClient()
  const { data: packs = [], isLoading } = useQuery<Pack[]>({
    queryKey: ['industry-packs'],
    queryFn: () => api.get('/organization/industry-packs').then(r => r.data.data),
  })
  const { data: org } = useQuery<{ settings?: { installedIndustryPacks?: string[] } }>({
    queryKey: ['organization'],
    queryFn: () => api.get('/organization').then(r => r.data),
  })
  const installed = new Set(org?.settings?.installedIndustryPacks ?? [])

  const install = useMutation({
    mutationFn: (packId: string) => api.post(INSTALL_PACK_PATH, { packId }).then(r => r.data),
    onSuccess: (_data, packId) => {
      toast.success('Industry pack installed', { description: packs.find(p => p.id === packId)?.label })
      qc.invalidateQueries({ queryKey: ['organization'] })
    },
    onError: (e: { response?: { data?: { detail?: string } } }) => {
      toast.error('Install failed', { description: e.response?.data?.detail ?? 'Try again in a moment.' })
    },
  })

  return (
    <div className="max-w-2xl space-y-5" data-testid="industry-packs-tab">
      <div>
        <h1 className="text-title text-ink-950">Industry packs</h1>
        <p className="text-dense text-ink-500 mt-1">
          Add contract types, templates, clauses and playbook positions for your industry, on top of the standard library.
          Installing is safe to repeat: nothing you've changed is overwritten.
        </p>
      </div>
      {isLoading && <p className="text-dense text-ink-400">Loading…</p>}
      <ul className="space-y-2">
        {packs.map(pack => {
          const done = installed.has(pack.id)
          const busy = install.isPending && install.variables === pack.id
          return (
            <li key={pack.id} className="bg-card rounded-card border border-paper-200 p-4 flex items-start gap-3">
              <Briefcase className="size-4 text-ink-500 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-body font-medium text-ink-950">{pack.label}</p>
                <p className="text-dense text-ink-500">{pack.description}</p>
              </div>
              {done ? (
                <span className="inline-flex items-center gap-1 text-dense text-ink-700" data-testid={`pack-installed-${pack.id}`}>
                  <CheckCircle2 className="size-4" /> Installed
                </span>
              ) : (
                <Button size="sm" variant="outline" disabled={install.isPending} onClick={() => install.mutate(pack.id)} data-testid={`pack-install-${pack.id}`}>
                  {busy ? <><Loader2 className="size-3.5 animate-spin" /> Installing…</> : 'Install'}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

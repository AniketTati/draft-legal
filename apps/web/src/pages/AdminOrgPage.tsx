import { useState, useEffect } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/common/Toaster'
import {
  Building2,
  Save,
  AlertCircle,
  Check,
  Bell,
  Cpu,
  BarChart3,
  Database,
} from 'lucide-react'
import { AiConfigTab } from '@/components/admin/AiConfigTab'
import { Card, EmptyState, Eyebrow } from '@/components/ui/primitives'

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = 'general' | 'alerts' | 'ai-config' | 'system' | 'data'

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'general', label: 'General', icon: Building2 },
  { id: 'alerts', label: 'Alert Rules', icon: Bell },
  { id: 'ai-config', label: 'AI Config', icon: Cpu },
  { id: 'system', label: 'System Dashboard', icon: BarChart3 },
  { id: 'data', label: 'Data Management', icon: Database },
]

// B.6.24 — accept both #RGB and #RRGGBB
function isValidHex(value: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim())
}

/*
 * The *customer's* brand color, not ours — this is tenant data, so it stays a
 * literal rather than a design-system token. Named here so no raw hex sits in a
 * style prop.
 */
const DEFAULT_BRAND_HEX = '#3B82F6'

// ─── Component ────────────────────────────────────────────────────────────────

export function AdminOrgPage() {
  const [activeTab, setActiveTab] = useState<Tab>('general')

  const { data: org } = useQuery({
    queryKey: ['organization'],
    queryFn: () => api.get('/organization').then(r => r.data),
  })

  // Form state — seed from org data
  const [orgName, setOrgName] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [brandColor, setBrandColor] = useState('')
  const [successMsg, setSuccessMsg] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  // Initialize form from fetched org data
  useEffect(() => {
    if (org) {
      setOrgName(org.name ?? '')
      setLogoUrl(org.logoUrl ?? '')
      setBrandColor(org.brandColor ?? '')
    }
  }, [org])

  const saveOrg = useMutation({
    mutationFn: (body: { name: string; logoUrl: string; brandColor: string }) =>
      api.patch('/organization', body).then(r => r.data),
    onSuccess: () => {
      setSuccessMsg('Organization settings saved.')
      setErrorMsg('')
      setTimeout(() => setSuccessMsg(''), 3000)
      toast.success('Organization settings saved')
    },
    onError: (e: any) => {
      const detail = e.response?.data?.detail ?? 'Failed to save settings'
      setErrorMsg(detail)
      setSuccessMsg('')
      toast.error('Save failed', { description: detail })
    },
  })

  const handleSave = () => {
    setErrorMsg('')
    setSuccessMsg('')
    saveOrg.mutate({ name: orgName, logoUrl, brandColor })
  }

  return (
    <div className="h-full flex bg-paper-50">
      {/* Sidebar tabs */}
      <aside className="w-52 border-r border-paper-200 bg-card flex-shrink-0 p-4">
        <Eyebrow className="mb-3">Organization</Eyebrow>
        <nav className="space-y-0.5">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              // Selected is a state, not an action, so it stays quiet — the ink
              // fill belongs to the app sidebar, not to an in-page rail sitting
              // next to this page's Save button.
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-dense transition-colors ${
                activeTab === id
                  ? 'bg-paper-100 text-ink-950 font-medium'
                  : 'text-ink-700 hover:bg-paper-100'
              }`}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <div className="flex-1 overflow-auto p-6">
        {/* ─── General ──────────────────────────────────────────────────── */}
        {activeTab === 'general' && (
          <div className="max-w-2xl space-y-6">
            <div>
              <h1 className="text-title text-ink-950">Organization Settings</h1>
              <p className="text-dense text-ink-500 mt-1">
                Manage your organization profile and branding.
              </p>
            </div>

            <Card className="p-5 space-y-4">
              <div>
                <Label className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Organization Name</Label>
                <Input
                  value={orgName}
                  onChange={e => setOrgName(e.target.value)}
                  placeholder="Acme Corp"
                />
              </div>

              <div>
                <Label className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Logo</Label>
                <div className="flex items-start gap-3">
                  {/* Preview — shows uploaded/URLed logo or a subtle placeholder */}
                  <div className="size-16 rounded-card border border-paper-200 bg-paper-50 flex items-center justify-center overflow-hidden shrink-0">
                    {logoUrl ? (
                      <img
                        src={logoUrl}
                        alt="Organization logo preview"
                        data-testid="logo-preview"
                        className="max-h-full max-w-full object-contain"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                      />
                    ) : (
                      <Building2 className="size-6 text-ink-400" />
                    )}
                  </div>
                  <div className="flex-1 space-y-1.5">
                    <Input
                      value={logoUrl}
                      onChange={e => setLogoUrl(e.target.value)}
                      placeholder="https://example.com/logo.png"
                      data-testid="logo-url"
                    />
                    <p className="text-[11px] text-ink-400 leading-relaxed">
                      Paste a URL to your logo (PNG or SVG). Direct file
                      upload lands in v1.1 — for now host on your own CDN
                      or intranet.
                    </p>
                  </div>
                </div>
              </div>

              <div>
                <Label className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Brand Color</Label>
                {/*
                  B.6.24 — native color picker + synced hex input. The
                  picker is the primary affordance (click the swatch to
                  open the OS color UI); the hex input is for power
                  users and still supports copy-paste from design
                  tools. Invalid hex falls back to the stored value
                  without mutating state.
                */}
                <div className="flex items-center gap-3">
                  <label className="relative inline-block cursor-pointer">
                    <input
                      type="color"
                      value={isValidHex(brandColor) ? brandColor : DEFAULT_BRAND_HEX}
                      onChange={e => setBrandColor(e.target.value)}
                      data-testid="brand-color-picker"
                      aria-label="Pick brand color"
                      className="sr-only"
                    />
                    <span
                      className="block size-10 rounded-md border border-paper-200 shadow-e1"
                      style={{ backgroundColor: isValidHex(brandColor) ? brandColor : DEFAULT_BRAND_HEX }}
                      aria-hidden
                    />
                  </label>
                  <Input
                    value={brandColor}
                    onChange={e => setBrandColor(e.target.value)}
                    placeholder="#3B82F6"
                    className="max-w-36 font-mono tabular-nums"
                    data-testid="brand-color-hex"
                  />
                  <span className="text-[11px] text-muted-foreground">
                    Click the swatch to pick, or paste a hex.
                  </span>
                </div>
              </div>

              <div>
                <Label className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Subscription Tier</Label>
                <div className="px-3 py-2 bg-paper-50 rounded-md border border-paper-200 text-body text-ink-700">
                  {org?.subscriptionTier ?? 'FREE'}
                </div>
              </div>

              {errorMsg && (
                <div className="flex items-center gap-2 p-3 bg-risk-50 border border-risk-200 rounded-md">
                  <AlertCircle className="size-4 text-risk-600 flex-shrink-0" />
                  <p className="text-dense text-risk-700">{errorMsg}</p>
                </div>
              )}

              {successMsg && (
                // Neutral, not brand: saving a settings form is an acknowledgement,
                // not a binding event. Emerald is reserved for approved/executed/signed.
                <div className="flex items-center gap-2 p-3 bg-paper-100 border border-paper-200 rounded-md">
                  <Check className="size-4 text-ink-500 flex-shrink-0" />
                  <p className="text-dense text-ink-700">{successMsg}</p>
                </div>
              )}

              <div className="flex justify-end pt-2 border-t border-paper-200">
                <Button onClick={handleSave} disabled={saveOrg.isPending} className="gap-2">
                  <Save className="size-4" />
                  {saveOrg.isPending ? 'Saving...' : 'Save Changes'}
                </Button>
              </div>
            </Card>
          </div>
        )}

        {/* ─── Placeholder tabs ─────────────────────────────────────────── */}
        {activeTab === 'alerts' && (
          <PlaceholderTab icon={Bell} title="Alert Rules" />
        )}
        {activeTab === 'ai-config' && <AiConfigTab />}
        {activeTab === 'system' && (
          <PlaceholderTab icon={BarChart3} title="System Dashboard" />
        )}
        {activeTab === 'data' && (
          <PlaceholderTab icon={Database} title="Data Management" />
        )}
      </div>
    </div>
  )
}

// ─── Placeholder ──────────────────────────────────────────────────────────────

function PlaceholderTab({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <div className="max-w-2xl">
      <h1 className="text-title text-ink-950 mb-6">{title}</h1>
      <EmptyState icon={<Icon />} title="Coming soon" className="py-16" />
    </div>
  )
}

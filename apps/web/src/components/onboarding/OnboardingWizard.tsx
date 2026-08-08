/**
 * OnboardingWizard — first-login flow.
 *
 * Replaces the previous 10-step wizard. The job-to-be-done is "get me to one
 * moment of value as fast as possible, then defer everything else". So we
 * do exactly two screens:
 *
 *   1. Pick your industry  → installs the industry pack which auto-seeds
 *                            contract types, templates, clauses, playbook
 *                            positions in one call.
 *   2. First contract      → upload your own or try a sample; either path
 *                            lands you on the contract detail page mid-AI-
 *                            analysis (the actual "aha" moment). Or skip and
 *                            explore.
 *
 * After screen 2 we mark `org.settings.onboardingCompleted = true` and unmount.
 * Everything else (invite team, configure approvals, customise playbook,
 * brand colour, logo) moves to the WelcomeChecklist on the dashboard so the
 * user is never blocked from using the product.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useDropzone } from 'react-dropzone'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/common/Toaster'
import {
  Briefcase,
  HeartPulse,
  Factory,
  FlaskConical,
  Truck,
  CircleHelp,
  Upload as UploadIcon,
  FileText,
  ArrowRight,
  ArrowLeft,
  Loader2,
  CheckCircle2,
} from 'lucide-react'

type IndustryPackId = 'saas' | 'healthcare' | 'manufacturing' | 'biotech' | 'logistics' | null

const INDUSTRY_OPTIONS: Array<{
  id: Exclude<IndustryPackId, null>
  label: string
  blurb: string
  icon: React.ComponentType<{ className?: string }>
}> = [
  { id: 'saas',          label: 'SaaS',          blurb: 'MSAs, DPAs, SLAs, customer + vendor agreements.',        icon: Briefcase    },
  { id: 'healthcare',    label: 'Healthcare',    blurb: 'BAAs, clinical trial agreements, vendor contracts.',     icon: HeartPulse   },
  { id: 'manufacturing', label: 'Manufacturing', blurb: 'Supplier agreements, purchase orders, distribution.',    icon: Factory      },
  { id: 'biotech',       label: 'Biotech',       blurb: 'CDAs, MTAs, research collaborations, licensing.',        icon: FlaskConical },
  { id: 'logistics',     label: 'Logistics',     blurb: 'Carrier agreements, freight terms, 3PL contracts.',      icon: Truck        },
]

export function OnboardingWizard() {
  const qc = useQueryClient()
  const navigate = useNavigate()

  const [step, setStep] = useState<1 | 2>(1)
  const [picked, setPicked] = useState<IndustryPackId>(null)

  const installIndustryPack = useMutation({
    mutationFn: (packId: Exclude<IndustryPackId, null>) =>
      api.post('/organization/install-industry-pack', { packId }).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['organization'] })
      qc.invalidateQueries({ queryKey: ['templates'] })
      qc.invalidateQueries({ queryKey: ['clauses'] })
    },
  })

  const finish = useMutation({
    mutationFn: () =>
      api.patch('/organization', { settings: { onboardingCompleted: true } }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['organization'] }),
  })

  async function pickIndustry(id: Exclude<IndustryPackId, null> | 'other') {
    if (id === 'other') {
      setPicked(null)
      setStep(2)
      return
    }
    try {
      await installIndustryPack.mutateAsync(id)
      setPicked(id)
      setStep(2)
    } catch {
      toast.error('Could not install pack', { description: 'Please try again.' })
    }
  }

  async function complete(thenNavigateTo: string | null) {
    await finish.mutateAsync()
    if (thenNavigateTo) navigate(thenNavigateTo)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-3xl rounded-card border border-paper-200 bg-card shadow-e3">
        {/* Top bar: 2-dot step indicator + skip */}
        <div className="flex items-center justify-between border-b border-paper-200 px-6 py-4">
          <div className="flex items-center gap-2 text-dense text-ink-500">
            <Dot active={step === 1} done={step > 1} />
            <span className={step === 1 ? 'font-medium text-ink-950' : ''}>Industry</span>
            <span className="mx-1 text-ink-400">·</span>
            <Dot active={step === 2} done={false} />
            <span className={step === 2 ? 'font-medium text-ink-950' : ''}>First contract</span>
          </div>
          <button
            onClick={() => complete(null)}
            className="text-dense text-ink-500 hover:text-ink-950"
            data-testid="onboarding-skip-all"
          >
            Skip setup
          </button>
        </div>

        {step === 1 && (
          <Step1Industry onPick={pickIndustry} loading={installIndustryPack.isPending} />
        )}
        {step === 2 && (
          <Step2FirstContract
            picked={picked}
            onBack={() => setStep(1)}
            onFinish={complete}
          />
        )}
      </div>
    </div>
  )
}

// ─── Step 1 ──────────────────────────────────────────────────────────────────

function Step1Industry({
  onPick,
  loading,
}: {
  onPick: (id: Exclude<IndustryPackId, null> | 'other') => void
  loading: boolean
}) {
  return (
    <div className="px-6 py-10 sm:px-10">
      <h1 className="text-title text-ink-950">
        What does your team work on?
      </h1>
      <p className="mt-2 text-body text-ink-500">
        We&apos;ll preload the right contract types, templates, clauses, and playbook positions — you
        can change anything later.
      </p>

      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {INDUSTRY_OPTIONS.map((opt) => {
          const Icon = opt.icon
          // Picking a tile is the action on this screen, so the hover
          // affordance is ink — not the brand green it used to borrow.
          return (
            <button
              key={opt.id}
              onClick={() => onPick(opt.id)}
              disabled={loading}
              data-testid={`onboarding-industry-${opt.id}`}
              className="group flex flex-col items-start gap-2 rounded-card border border-paper-200 bg-paper-50 p-4 text-left transition-colors hover:border-ink-950 hover:bg-paper-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="grid size-9 place-items-center rounded-md bg-paper-100 text-ink-700">
                <Icon className="size-4" />
              </span>
              <span className="text-body font-semibold text-ink-950">{opt.label}</span>
              <span className="text-dense text-ink-500">{opt.blurb}</span>
            </button>
          )
        })}
        <button
          onClick={() => onPick('other')}
          disabled={loading}
          data-testid="onboarding-industry-other"
          className="group flex flex-col items-start gap-2 rounded-card border border-dashed border-paper-300 bg-paper-50 p-4 text-left transition-colors hover:border-ink-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="grid size-9 place-items-center rounded-md bg-paper-100 text-ink-500">
            <CircleHelp className="size-4" />
          </span>
          <span className="text-body font-semibold text-ink-950">Other / not sure</span>
          <span className="text-dense text-ink-500">
            Skip the pack — you can install one later from Settings.
          </span>
        </button>
      </div>

      {loading && (
        <div className="mt-6 flex items-center gap-2 text-dense text-ink-500">
          <Loader2 className="size-3.5 animate-spin" /> Installing pack…
        </div>
      )}
    </div>
  )
}

// ─── Step 2 ──────────────────────────────────────────────────────────────────

function Step2FirstContract({
  picked,
  onBack,
  onFinish,
}: {
  picked: IndustryPackId
  onBack: () => void
  onFinish: (thenNavigateTo: string | null) => Promise<void>
}) {
  const [uploading, setUploading] = useState(false)
  const [seeding, setSeeding] = useState(false)

  const { data: contracts } = useQuery<{ data: Array<{ id: string; title: string }> }>({
    queryKey: ['contracts', 'first-contract-probe'],
    queryFn: () => api.get('/contracts?limit=1').then(r => r.data),
    staleTime: 30_000,
  })
  const firstContractId = contracts?.data?.[0]?.id ?? null

  const uploadMut = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData()
      form.append('file', file)
      form.append('title', file.name.replace(/\.[^.]+$/, ''))
      form.append('type', 'OTHER')
      const { data } = await api.post('/contracts/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      return data as { id: string }
    },
  })

  const onDrop = async (files: File[]) => {
    if (!files[0]) return
    setUploading(true)
    try {
      const c = await uploadMut.mutateAsync(files[0])
      await onFinish(`/contracts/${c.id}`)
    } catch {
      toast.error('Upload failed', { description: 'Try again or pick the sample.' })
    } finally {
      setUploading(false)
    }
  }

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: false,
    accept: {
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      // No legacy .doc — the extraction pipeline can't read OLE, so the server
      // rejects it. Don't let onboarding offer a format that always fails.
      'text/plain': ['.txt'],
    },
  })

  async function useSample() {
    setSeeding(true)
    try {
      if (firstContractId) await onFinish(`/contracts/${firstContractId}`)
      else await onFinish('/contracts')
    } finally {
      setSeeding(false)
    }
  }

  return (
    <div className="px-6 py-10 sm:px-10">
      {picked && (
        // "Pack installed" is a setup fact, not a binding state — neutral chip.
        <span className="inline-flex items-center gap-1.5 rounded-full border border-paper-200 bg-paper-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-700">
          <CheckCircle2 className="size-3" />
          {picked} pack installed
        </span>
      )}
      <h1 className="mt-3 text-title text-ink-950">
        See what an agent does with a real contract.
      </h1>
      <p className="mt-2 text-body text-ink-500">
        Drop a PDF or DOCX — our agents parse, classify, extract key terms, score risk, and index
        it for search. Takes about 30 seconds.
      </p>

      <div
        {...getRootProps()}
        className={`mt-8 flex cursor-pointer flex-col items-center justify-center rounded-card border-2 border-dashed p-10 text-center transition-colors ${
          isDragActive
            ? 'border-ink-950 bg-paper-100'
            : 'border-paper-300 bg-paper-50 hover:border-ink-400 hover:bg-paper-100'
        }`}
        data-testid="onboarding-dropzone"
      >
        <input {...getInputProps()} />
        <span className="grid size-12 place-items-center rounded-full bg-paper-100 text-ink-700">
          {uploading ? <Loader2 className="size-5 animate-spin" /> : <UploadIcon className="size-5" />}
        </span>
        <div className="mt-3 text-body font-medium text-ink-950">
          {uploading ? 'Uploading…' : 'Drop a contract here, or click to browse'}
        </div>
        <div className="mt-1 text-dense text-ink-500">PDF, DOCX, or TXT</div>
      </div>

      <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-between">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={uploading || seeding}>
          <ArrowLeft className="mr-1.5 size-4" /> Back
        </Button>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {firstContractId && (
            <Button
              variant="outline"
              onClick={useSample}
              disabled={uploading || seeding}
              data-testid="onboarding-try-sample"
            >
              {seeding ? (
                <Loader2 className="mr-1.5 size-4 animate-spin" />
              ) : (
                <FileText className="mr-1.5 size-4" />
              )}
              Try a sample contract
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => onFinish(null)}
            disabled={uploading || seeding}
            data-testid="onboarding-skip-to-dashboard"
          >
            Skip — explore first <ArrowRight className="ml-1.5 size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── tiny atoms ──────────────────────────────────────────────────────────────

// Step position is chrome, not meaning: the current and completed steps read as
// ink (the "you are here" treatment), and nothing here is binding.
function Dot({ active, done }: { active: boolean; done: boolean }) {
  if (done) return <CheckCircle2 className="size-3.5 text-ink-950" />
  return (
    <span
      className={`inline-block size-2 rounded-full ${
        active ? 'bg-ink-950' : 'bg-paper-300'
      }`}
    />
  )
}

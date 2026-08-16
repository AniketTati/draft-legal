import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  UsersRound,
  X,
  AlertCircle,
  CalendarOff,
} from 'lucide-react'
import { Card, EmptyState } from '@/components/ui/primitives'
import { MEANING_CLASS } from '@/lib/status'

// ─── Types ───────────────────────────────────────────────────────────────────

interface TeamMember {
  id: string
  name: string
  email: string
  avatarUrl: string | null
  roles: string[]
  lastActiveAt: string | null
  outOfOffice: boolean
  outOfOfficeUntil: string | null
  delegateToId: string | null
  activeContracts: number
  pendingApprovals: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getInitials(name: string): string {
  return name
    .split(' ')
    .map(p => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

/*
 * A capacity meter reads on the same three meanings as a risk meter: healthy
 * capacity is binding-green, a stretched person is your-turn amber (someone
 * needs to rebalance), and an overloaded one is risk. The count thresholds are
 * the product's own — only the colors move onto the meaning tokens.
 */
function workloadColor(count: number): string {
  if (count < 5) return MEANING_CLASS.binding.dot
  if (count <= 10) return MEANING_CLASS.turn.dot
  return MEANING_CLASS.risk.dot
}

/*
 * The bar used to be `count / 15`, i.e. anything from 15 contracts upward drew
 * an identical full bar. In the seeded org one owner holds 380 and everyone
 * else holds 0, so every card rendered either "completely full" or "completely
 * empty" and the row stopped carrying information at exactly the point it was
 * needed. Scaling against the busiest member instead makes the bar a
 * comparison, which is what a capacity row is for. The colour thresholds are
 * unchanged — those are the product's absolute judgement about a person's
 * book, and they should not move with the team.
 */
function workloadPercent(count: number, peak: number): number {
  if (count <= 0) return 0
  const denom = Math.max(peak, 1)
  // Floor at 4% so a non-zero book is never drawn as nothing.
  return Math.max(4, Math.min(count / denom, 1) * 100)
}

// A role is metadata, not a state and not an action — so it stays neutral.
const ROLE_STYLES = 'bg-paper-100 text-ink-700 border border-paper-200'

// ─── Component ───────────────────────────────────────────────────────────────

export function TeamPage() {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [showOooModal, setShowOooModal] = useState(false)

  const qc = useQueryClient()

  const { data: members, isLoading } = useQuery<TeamMember[]>({
    queryKey: ['team-workload'],
    queryFn: () => api.get('/team/workload').then(r => r.data),
  })

  const team = members ?? []
  // Busiest book on the team, used as the bar's denominator.
  const peakLoad = useMemo(
    () => team.reduce((max, m) => Math.max(max, m.activeContracts), 0),
    [team]
  )

  const handleSetOoo = (userId: string) => {
    setSelectedUserId(userId)
    setShowOooModal(true)
  }

  const selectedMember = team.find(m => m.id === selectedUserId)

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-title text-ink-950 flex items-center gap-2">
            <UsersRound className="size-5" />
            Team Workload
          </h1>
          <p className="text-dense text-ink-500 mt-1">
            Monitor team capacity, workload, and out-of-office status.
          </p>
        </div>
        <Button
          onClick={() => {
            setSelectedUserId(null)
            setShowOooModal(true)
          }}
          variant="outline"
          className="gap-2"
        >
          <CalendarOff className="size-4" />
          Set OOO
        </Button>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="flex justify-center py-12">
          <div className="size-5 border-2 border-paper-300 border-t-ink-950 rounded-full animate-spin" />
        </div>
      ) : team.length === 0 ? (
        <EmptyState icon={<UsersRound />} title="No team members found" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {team.map(member => (
            <Card
              key={member.id}
              className="p-5 space-y-4 transition-colors hover:border-paper-300"
            >
              {/* Avatar + Info */}
              <div className="flex items-start gap-3">
                {member.avatarUrl ? (
                  <img
                    src={member.avatarUrl}
                    alt={member.name}
                    className="size-10 rounded-full object-cover"
                  />
                ) : (
                  <div className="size-10 rounded-full bg-paper-100 text-ink-700 flex items-center justify-center text-dense font-semibold shrink-0">
                    {getInitials(member.name)}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-body font-semibold text-ink-950 truncate">
                      {member.name}
                    </p>
                    {member.outOfOffice && (
                      // Attention, not decoration: an absent owner is what makes
                      // their queue somebody else's problem to delegate.
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-chip text-[10px] font-bold bg-attention-100 text-attention-700 shrink-0">
                        OOO
                      </span>
                    )}
                  </div>
                  <p className="text-dense text-ink-500 truncate">{member.email}</p>
                  {member.outOfOffice && member.outOfOfficeUntil && (
                    // A return date that has already passed while the flag is
                    // still set means the queue is being held for someone who
                    // is back at their desk — worth naming, not worth colouring
                    // as a live absence.
                    new Date(member.outOfOfficeUntil) < new Date() ? (
                      <p className="mt-0.5 text-[11px] text-ink-500">
                        Was due back {new Date(member.outOfOfficeUntil).toLocaleDateString()} — still flagged out
                      </p>
                    ) : (
                      <p className="text-[11px] text-attention-700 mt-0.5">
                        Returns {new Date(member.outOfOfficeUntil).toLocaleDateString()}
                      </p>
                    )
                  )}
                </div>
                <button
                  onClick={() => handleSetOoo(member.id)}
                  className="p-1.5 rounded-md text-ink-400 hover:text-ink-700 hover:bg-paper-100 transition-colors shrink-0"
                  title="Set out-of-office"
                >
                  <CalendarOff className="size-3.5" />
                </button>
              </div>

              {/* Role badges */}
              <div className="flex flex-wrap gap-1">
                {member.roles.map(role => (
                  <span
                    key={role}
                    className={`inline-flex items-center px-2 py-0.5 rounded-chip text-[11px] font-medium ${ROLE_STYLES}`}
                  >
                    {role}
                  </span>
                ))}
              </div>

              {/* Stats */}
              <div className="flex items-center gap-4 text-dense text-ink-500">
                <span>
                  <span className="font-semibold tabular-nums text-ink-950">{member.activeContracts}</span>{' '}
                  contracts
                </span>
                <span>
                  <span className="font-semibold tabular-nums text-ink-950">{member.pendingApprovals}</span>{' '}
                  approvals pending
                </span>
              </div>

              {/* Workload bar */}
              <div>
                <div className="flex items-center justify-between text-[11px] text-ink-500 mb-1">
                  {/* Say what the bar is measured against, or a full bar means
                      nothing. */}
                  <span>Workload{peakLoad > 0 && <span className="text-ink-400"> · vs {peakLoad} peak</span>}</span>
                  <span className="tabular-nums">{member.activeContracts} active</span>
                </div>
                <div
                  className="h-1 w-full overflow-hidden rounded-full bg-paper-100"
                  role="meter"
                  aria-valuenow={member.activeContracts}
                  aria-valuemin={0}
                  aria-valuemax={Math.max(peakLoad, 1)}
                  aria-label={`${member.name}: ${member.activeContracts} active contracts, busiest on the team holds ${peakLoad}`}
                >
                  <div
                    className={`h-full rounded-full transition-all ${workloadColor(member.activeContracts)}`}
                    style={{ width: `${workloadPercent(member.activeContracts, peakLoad)}%` }}
                  />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* OOO Modal */}
      {showOooModal && (
        <OooModal
          members={team}
          selectedMember={selectedMember ?? null}
          onClose={() => {
            setShowOooModal(false)
            setSelectedUserId(null)
          }}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ['team-workload'] })
            setShowOooModal(false)
            setSelectedUserId(null)
          }}
        />
      )}
    </div>
  )
}

// ─── OOO Modal ───────────────────────────────────────────────────────────────

function OooModal({
  members,
  selectedMember,
  onClose,
  onSuccess,
}: {
  members: TeamMember[]
  selectedMember: TeamMember | null
  onClose: () => void
  onSuccess: () => void
}) {
  const [userId, setUserId] = useState(selectedMember?.id ?? '')
  const [outOfOffice, setOutOfOffice] = useState(selectedMember?.outOfOffice ?? true)
  const [returnDate, setReturnDate] = useState(
    selectedMember?.outOfOfficeUntil
      ? new Date(selectedMember.outOfOfficeUntil).toISOString().split('T')[0]
      : ''
  )
  const [delegateId, setDelegateId] = useState(selectedMember?.delegateToId ?? '')
  const [error, setError] = useState('')
  const today = new Date().toISOString().split('T')[0]

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const current = members.find(m => m.id === userId) ?? null
  const delegate = members.find(m => m.id === delegateId) ?? null

  const mutation = useMutation({
    mutationFn: (body: { outOfOffice: boolean; outOfOfficeUntil: string | null; delegateToId: string | null }) =>
      api.patch(`/team/${userId}/ooo`, body).then(r => r.data),
    onSuccess,
    onError: (err: any) => {
      setError(err.response?.data?.detail ?? 'Failed to update out-of-office status')
    },
  })

  const handleSubmit = () => {
    setError('')
    if (!userId) return setError('Please select a team member')
    // A return date in the past reads as "already back" everywhere it is
    // displayed, so the record would contradict the flag from the moment it
    // was saved.
    if (outOfOffice && returnDate && returnDate < today) {
      return setError('The return date is in the past. Pick today or later, or leave it blank for an open-ended absence.')
    }
    mutation.mutate({
      outOfOffice,
      outOfOfficeUntil: outOfOffice ? (returnDate || null) : null,
      // Clearing out-of-office should not leave a delegate holding the queue.
      delegateToId: outOfOffice ? (delegateId || null) : null,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink-950/50" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ooo-title"
        className="relative w-full max-w-md rounded-card border border-paper-200 bg-card shadow-e3"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-paper-200">
          <h2 id="ooo-title" className="text-section text-ink-950">Set Out-of-Office</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md text-ink-400 hover:text-ink-700 hover:bg-paper-100"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* User selector */}
          <div>
            <Label className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Team Member *</Label>
            <select
              value={userId}
              onChange={e => {
                setUserId(e.target.value)
                const m = members.find(x => x.id === e.target.value)
                if (m) {
                  /*
                   * This was `m.outOfOffice || true`, which is `true` for every
                   * input. Selecting a member who is already out therefore
                   * looked identical to selecting one who is in, and the form
                   * could not represent "bring this person back" at all —
                   * clearing an absence was only reachable by unticking a box
                   * that had silently re-ticked itself.
                   */
                  setOutOfOffice(m.outOfOffice)
                  setReturnDate(
                    m.outOfOfficeUntil
                      ? new Date(m.outOfOfficeUntil).toISOString().split('T')[0]
                      : ''
                  )
                  setDelegateId(m.delegateToId ?? '')
                }
              }}
              className="w-full h-8 rounded-md border border-input bg-card px-[11px] text-[13px] text-ink-950 focus:outline-none focus:border-brand-700 focus:ring-[3px] focus:ring-brand-700/15"
            >
              <option value="">Select a member...</option>
              {members.map(m => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.email})
                </option>
              ))}
            </select>
          </div>

          {/* Toggle */}
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={outOfOffice}
                onChange={e => setOutOfOffice(e.target.checked)}
                data-testid="ooo-toggle"
                className="rounded-chip border-paper-300 accent-ink-950"
              />
              <span className="text-body text-ink-700">
                {current?.outOfOffice && !outOfOffice
                  ? `Bring ${current.name.split(' ')[0]} back — clears the absence and the delegate`
                  : 'Mark as out-of-office'}
              </span>
            </label>
          </div>

          {/* Return date + delegate only apply while someone is out. */}
          {outOfOffice && (
            <>
              <div>
                <Label htmlFor="ooo-return" className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Return Date</Label>
                <Input
                  id="ooo-return"
                  type="date"
                  // A return date before today contradicts the OOO flag the
                  // moment it is saved.
                  min={today}
                  value={returnDate}
                  onChange={e => setReturnDate(e.target.value)}
                />
                <p className="mt-1 text-[11px] text-ink-400">
                  Leave blank for an open-ended absence.
                </p>
              </div>

              <div>
                <Label htmlFor="ooo-delegate" className="text-[11.5px] font-semibold text-ink-950 mb-1.5 block">Delegate To</Label>
                <select
                  id="ooo-delegate"
                  value={delegateId}
                  onChange={e => setDelegateId(e.target.value)}
                  className="w-full h-8 rounded-md border border-input bg-card px-[11px] text-[13px] text-ink-950 focus:outline-none focus:border-brand-700 focus:ring-[3px] focus:ring-brand-700/15"
                >
                  <option value="">None</option>
                  {members
                    .filter(m => m.id !== userId)
                    .map(m => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.outOfOffice ? ' — out of office' : ''}
                      </option>
                    ))}
                </select>
                {/* Routing a queue to someone who is also away is how an
                    approval sits untouched for a fortnight. */}
                {delegate?.outOfOffice && (
                  <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-attention-700">
                    <AlertCircle className="mt-px size-3.5 flex-shrink-0" />
                    {delegate.name} is also out of office
                    {delegate.outOfOfficeUntil
                      ? ` until ${new Date(delegate.outOfOfficeUntil).toLocaleDateString()}`
                      : ''}
                    . Approvals routed here will wait.
                  </p>
                )}
              </div>
            </>
          )}

          {error && (
            <div className="flex items-center gap-2 p-3 bg-risk-50 border border-risk-200 rounded-md">
              <AlertCircle className="size-4 text-risk-600 flex-shrink-0" />
              <p className="text-dense text-risk-700">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-paper-200">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending} className="gap-2">
            <CalendarOff className="size-4" />
            {mutation.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}

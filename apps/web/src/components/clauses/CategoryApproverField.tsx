/**
 * docs/41 Part 7 — "Decides exceptions" for one clause category.
 *
 * When a contract's clause is outside the playbook, the person working on it
 * can ask for an exception. Someone has to decide it: a named person, or
 * anyone with a role. Without one, asking fails with "an admin must name a
 * clause approver", so the setting lives here, next to the category.
 * A sub-category with no one named uses its parent's.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { serverMessage } from '@/lib/approval-keys'
import { Button } from '@/components/ui/button'
import {
  approverChoice, approverPatch, decidesExceptionsWords, approverFor, approverName,
  type ApproverCategory, type NamedRole, type NamedUser,
} from '@/lib/clause-approver'

/** `saveUrl`: where the choice is saved — the Clauses page (edit:clause) by default, the Playbook page passes its own (edit:playbook). */
export function CategoryApproverField({ category, all, saveUrl }: { category: ApproverCategory; all: ApproverCategory[]; saveUrl?: string }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const current = approverChoice(category)
  const [choice, setChoice] = useState(current)
  // Another category picked, or the setting saved: start from what is stored.
  useEffect(() => { setEditing(false); setChoice(current) }, [category.id, current])

  const { data: usersData } = useQuery({
    queryKey: ['org-users'],
    queryFn: () => api.get('/users').then(r => r.data),
    staleTime: 60_000,
  })
  const users: NamedUser[] = usersData?.data ?? usersData ?? []
  const { data: rolesData } = useQuery<NamedRole[]>({
    queryKey: ['roles'],
    queryFn: () => api.get('/admin/users/roles').then(r => r.data),
    staleTime: 60_000,
  })
  const roles: NamedRole[] = rolesData ?? []

  const save = useMutation({
    meta: { errorHandled: true },
    mutationFn: (value: string) => api.patch(saveUrl ?? `/clauses/categories/${category.id}`, approverPatch(value)).then(r => r.data),
    onSuccess: () => {
      setEditing(false)
      qc.invalidateQueries({ queryKey: ['clause-categories'] })
    },
  })

  const own = !!(category.approverUserId || category.approverRoleId)
  // Nothing set here: say whose setting applies instead, when a parent has one.
  const inherited = !own && category.parentCategoryId ? approverName(approverFor(category.parentCategoryId, all), users, roles) : null

  return (
    <div className="border-t border-paper-200 px-3 py-2.5 text-[12px]" data-testid="category-approver">
      <p className="text-eyebrow uppercase text-ink-700 mb-1 truncate" title={category.name}>{category.name}</p>
      {!editing ? (
        <div className="space-y-1">
          <p className="text-ink-700">
            <span className="text-ink-500">Decides exceptions: </span>
            <span className="font-medium text-ink-950" data-testid="category-approver-value">
              {own ? decidesExceptionsWords(category, users, roles) : inherited ? `${inherited} (from the parent category)` : 'No one yet'}
            </span>
          </p>
          <button type="button" className="text-[11.5px] underline text-ink-700 hover:text-ink-950" onClick={() => { save.reset(); setEditing(true) }} data-testid="category-approver-edit">
            Change
          </button>
        </div>
      ) : (
        <div className="space-y-1.5">
          <label className="block">
            <span className="block text-ink-500 mb-1">Decides exceptions</span>
            <select
              value={choice}
              onChange={e => setChoice(e.target.value)}
              className="w-full h-8 text-[12px] text-ink-950 border border-input rounded-md px-2 bg-card focus-visible:outline-none focus-visible:border-brand-700"
              data-testid="category-approver-select"
            >
              <option value="">No one yet</option>
              <optgroup label="A person">
                {users.map(u => <option key={u.id} value={`user:${u.id}`}>{u.name || u.email}</option>)}
              </optgroup>
              <optgroup label="Anyone with a role">
                {roles.map(r => <option key={r.id} value={`role:${r.id}`}>{r.name}</option>)}
              </optgroup>
            </select>
          </label>
          {save.isError && <p role="alert" className="text-[11.5px] text-risk-700">{serverMessage(save.error)}</p>}
          <div className="flex gap-1.5">
            <Button size="xs" onClick={() => save.mutate(choice)} disabled={save.isPending || choice === current} data-testid="category-approver-save">
              {save.isPending && <Loader2 className="animate-spin" />} Save
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)} disabled={save.isPending}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}

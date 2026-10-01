import { describe, it, expect } from 'vitest'
import { approverChoice, approverFor, approverName, approverPatch, decidesExceptionsWords, flattenCategories } from './clause-approver'

const tree = [
  { id: 'a', name: 'Liability', approverUserId: 'u1', children: [{ id: 'a1', name: 'Caps', parentCategoryId: 'a', children: [{ id: 'a1x', name: 'Super caps', parentCategoryId: 'a1' }] }] },
  { id: 'b', name: 'Confidentiality', approverRoleId: 'r1' },
  { id: 'c', name: 'Notice' },
]
const users = [{ id: 'u1', name: 'Priya Shah', email: 'p@x' }]
const roles = [{ id: 'r1', name: 'Legal' }]

describe('who decides exceptions (docs/41 Part 7)', () => {
  it('reads the category tree at any depth', () => {
    expect(flattenCategories(tree).map(c => c.id)).toEqual(['a', 'a1', 'a1x', 'b', 'c'])
  })
  it('uses the parent’s approver when a category names no one, as the API does', () => {
    const all = flattenCategories(tree)
    expect(approverFor('a1x', all)).toEqual({ userId: 'u1', roleId: null })
    expect(approverFor('c', all)).toBeNull()
    expect(approverFor(null, all)).toBeNull()
  })
  it('says it in plain words', () => {
    expect(decidesExceptionsWords(tree[0], users, roles)).toBe('Priya Shah')
    expect(decidesExceptionsWords(tree[1], users, roles)).toBe('Anyone with the Legal role')
    expect(decidesExceptionsWords(tree[2], users, roles)).toBe('No one yet')
    expect(approverName({ userId: 'gone', roleId: null }, users, roles)).toBeNull()
  })
  it('names a person or a role, or clears both', () => {
    expect(approverChoice(tree[0])).toBe('user:u1')
    expect(approverChoice(tree[1])).toBe('role:r1')
    expect(approverPatch('user:u1')).toEqual({ approverUserId: 'u1' })
    expect(approverPatch('role:r1')).toEqual({ approverRoleId: 'r1' })
    expect(approverPatch('')).toEqual({ approverUserId: null, approverRoleId: null })
  })
})

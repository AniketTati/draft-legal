/**
 * docs/41 Part 20 — the SCIM grammar identity providers actually send: the
 * `eq` filters, both PATCH shapes (Okta's path form, Entra ID's value form
 * with "False" strings), and group member operations.
 */
import { describe, it, expect } from 'vitest'
import { parseFilter, userPatchChanges, groupPatchChanges, scimEmail, scimName, scimBool, toScimUser } from './scim.js'

describe('SCIM filters', () => {
  it('reads attribute eq "value", case-insensitive on the attribute', () => {
    expect(parseFilter('userName eq "jane@acme.com"')).toEqual({ attribute: 'username', value: 'jane@acme.com' })
    expect(parseFilter('externalId EQ "00u1\\"x"')).toEqual({ attribute: 'externalid', value: '00u1"x' })
    expect(parseFilter(undefined)).toBeNull()
  })

  it('refuses anything else as invalid', () => {
    expect(parseFilter('userName sw "j"')).toBe('invalid')
    expect(parseFilter('userName eq "a" or userName eq "b"')).toBe('invalid')
  })
})

describe('SCIM user PATCH', () => {
  it('Okta: replace with a path', () => {
    expect(userPatchChanges([{ op: 'replace', path: 'active', value: false }])).toEqual({ active: false })
  })

  it('Entra ID: replace with a value object, booleans as strings', () => {
    expect(userPatchChanges([{ op: 'Replace', value: { active: 'False', displayName: 'Jane D' } }])).toEqual({ active: false, name: 'Jane D' })
    expect(userPatchChanges([{ op: 'Add', path: 'externalId', value: 'abc' }, { op: 'replace', path: 'name', value: { givenName: 'Jane', familyName: 'Doe' } }]))
      .toEqual({ externalId: 'abc', name: 'Jane Doe' })
  })

  it('refuses a body without operations', () => {
    expect(userPatchChanges(undefined)).toBe('invalid')
  })
})

describe('SCIM group PATCH', () => {
  it('adds and removes members, including Entra ID\'s filtered remove', () => {
    expect(groupPatchChanges([
      { op: 'add', path: 'members', value: [{ value: 'u1' }, { value: 'u2' }] },
      { op: 'remove', path: 'members[value eq "u3"]' },
      { op: 'remove', path: 'members', value: [{ value: 'u4' }] },
    ])).toEqual({ add: ['u1', 'u2'], remove: ['u3', 'u4'] })
  })

  it('replaces the member list and the name', () => {
    expect(groupPatchChanges([{ op: 'replace', value: { displayName: 'Legal', members: [{ value: 'u9' }] } }]))
      .toEqual({ add: [], remove: [], displayName: 'Legal', replaceMembers: ['u9'] })
  })
})

describe('SCIM users', () => {
  it('takes the email from userName or the primary email, and a name from what is sent', () => {
    expect(scimEmail({ userName: 'Jane@Acme.com' })).toBe('jane@acme.com')
    expect(scimEmail({ userName: 'jdoe', emails: [{ value: 'x@acme.com' }, { value: 'jane@acme.com', primary: 'true' }] })).toBe('jane@acme.com')
    expect(scimEmail({ userName: 'jdoe' })).toBeNull()
    expect(scimName({ name: { givenName: 'Jane', familyName: 'Doe' } })).toBe('Jane Doe')
    expect(scimName({ displayName: 'JD' })).toBe('JD')
    expect(scimBool('True')).toBe(true)
    expect(scimBool('maybe')).toBeUndefined()
  })

  it('shows a deactivated user as inactive', () => {
    const u = toScimUser({ id: 'u1', email: 'a@b.co', name: 'Ann Bee', status: 'DEACTIVATED', createdAt: new Date(), updatedAt: new Date() }, 'ext1', 'https://x/scim/v2')
    expect(u).toMatchObject({ id: 'u1', userName: 'a@b.co', active: false, externalId: 'ext1', name: { givenName: 'Ann', familyName: 'Bee' } })
  })
})

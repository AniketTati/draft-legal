/**
 * Resolving `ContractVersion.createdById` to a name for `w:author`.
 *
 * This is fiddlier than it looks. `createdById` is a bare `String` on
 * ContractVersion — there is no Prisma relation to User, so `include:
 * { createdBy: true }` will not even compile — and it is not always a user id:
 *
 *   `portal:<shareLinkId>`  written by routes/portal.ts when the counterparty
 *                           uploads a redline through a share link
 *   `email:<address>`       written by routes/inbound-email.ts when a redline
 *                           arrives as an email reply
 *   `<cuid>`                an actual User id, every other path
 *
 * A naive `user.findUnique` returns null for exactly the first two — which are
 * the counterparty-authored versions a redline is usually about. Word shows
 * w:author in the review pane and on every change tooltip, so getting this
 * wrong means the other side's markup is attributed to a blank, or worse to a
 * raw database identifier.
 */
import { prisma } from './prisma.js'

/** Word renders control characters and stray quotes badly; keep it plain. */
function clean(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1F\x7F]/g, '').replace(/"/g, "'").trim().slice(0, 120)
}

/**
 * Resolve one `createdById` to a display name.
 *
 * `fallback` is used when nothing resolves — pass the org name so the document
 * is at least attributed to the tenant rather than to an empty string, which
 * Word renders as an anonymous author.
 */
export async function resolveRevisionAuthor(
  createdById: string,
  fallback = 'draftLegal',
): Promise<string> {
  if (!createdById) return clean(fallback)

  if (createdById.startsWith('portal:')) {
    const link = await prisma.contractShareLink.findUnique({
      where:  { id: createdById.slice('portal:'.length) },
      select: { label: true, invitedEmail: true },
    })
    // `label` is what the sender typed ("Acme legal"); invitedEmail is the
    // address it went to. Either is more use to a reviewer than the link id.
    const name = link?.label?.trim() || link?.invitedEmail?.trim()
    return clean(name ? `${name} (counterparty)` : 'Counterparty')
  }

  if (createdById.startsWith('email:')) {
    const addr = createdById.slice('email:'.length).trim()
    return clean(addr ? `${addr} (counterparty)` : 'Counterparty')
  }

  const user = await prisma.user.findUnique({
    where:  { id: createdById },
    select: { name: true, email: true },
  })
  // User.name is non-nullable in the schema but can still be an empty string.
  const name = user?.name?.trim() || user?.email?.trim()
  return clean(name || fallback)
}

/**
 * Batch form, for lists of versions.
 *
 * Same ladder, three queries instead of N. The version list needs this: the
 * Compare view shows an author beside every version and displayed "Unknown"
 * for all of them, because `GET /contracts/:id/versions` returned only the raw
 * `createdById` while the UI read `createdByName ?? authorName`.
 */
export async function resolveRevisionAuthors(
  createdByIds: readonly string[],
  fallback = 'draftLegal',
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = [...new Set(createdByIds.filter(Boolean))]
  if (!ids.length) return out

  const linkIds = ids.filter(i => i.startsWith('portal:')).map(i => i.slice('portal:'.length))
  const userIds = ids.filter(i => !i.startsWith('portal:') && !i.startsWith('email:'))

  const [links, users] = await Promise.all([
    linkIds.length
      ? prisma.contractShareLink.findMany({
          where: { id: { in: linkIds } },
          select: { id: true, label: true, invitedEmail: true },
        })
      : Promise.resolve([]),
    userIds.length
      ? prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        })
      : Promise.resolve([]),
  ])
  const linkById = new Map(links.map(l => [l.id, l]))
  const userById = new Map(users.map(u => [u.id, u]))

  for (const id of ids) {
    if (id.startsWith('portal:')) {
      const l = linkById.get(id.slice('portal:'.length))
      const name = l?.label?.trim() || l?.invitedEmail?.trim()
      out.set(id, clean(name ? `${name} (counterparty)` : 'Counterparty'))
    } else if (id.startsWith('email:')) {
      const addr = id.slice('email:'.length).trim()
      out.set(id, clean(addr ? `${addr} (counterparty)` : 'Counterparty'))
    } else {
      const u = userById.get(id)
      out.set(id, clean(u?.name?.trim() || u?.email?.trim() || fallback))
    }
  }
  return out
}

/**
 * `w:date` is an `xsd:dateTime`. Word tolerates milliseconds unevenly and some
 * readers reject them outright, so drop them and keep the trailing Z.
 */
export function toRevisionDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

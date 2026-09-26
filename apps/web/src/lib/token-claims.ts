/** X50 — a JWT's claims, read without verifying it: only to compare sessions. */
export function tokenClaims(token: string | null | undefined): { sub?: string; exp?: number; iat?: number } {
  try {
    const part = token?.split('.')[1]
    return part ? JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) : {}
  } catch {
    return {}
  }
}

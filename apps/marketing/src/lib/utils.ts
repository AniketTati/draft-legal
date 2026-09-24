import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const APP_URL = 'https://app.draft-legal.com'
export const SITE_URL = 'https://draft-legal.com'
export const GITHUB_URL = 'https://github.com/AniketTati/draft-legal'

/**
 * X70 — the origin the site's forms post to. A production build posts to the
 * app site, which proxies /api/** to api-service. The dev server posts to the
 * local API through its /api proxy (vite.config.ts): the contact form used to
 * post to production from a local run, filing test enquiries there.
 * VITE_API_ORIGIN overrides both (for example, to try a build against staging).
 */
export const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? (import.meta.env.DEV ? '' : 'https://draftlegal-prod-13353.web.app')

import { useEffect } from 'react'
import { SITE_URL } from './utils'

type SEOProps = {
  title: string
  description: string
  path: string
  schema?: Record<string, unknown> | Record<string, unknown>[]
  ogImage?: string
}

const upsertMeta = (selector: string, attr: 'name' | 'property', key: string, content: string) => {
  let el = document.head.querySelector<HTMLMetaElement>(selector)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute(attr, key)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

const upsertLink = (rel: string, href: string) => {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)
  if (!el) {
    el = document.createElement('link')
    el.setAttribute('rel', rel)
    document.head.appendChild(el)
  }
  el.setAttribute('href', href)
}

const upsertScript = (id: string, json: string) => {
  let el = document.head.querySelector<HTMLScriptElement>(`script#${id}`)
  if (!el) {
    el = document.createElement('script')
    el.id = id
    el.type = 'application/ld+json'
    document.head.appendChild(el)
  }
  el.textContent = json
}

export function SEO({ title, description, path, schema, ogImage = '/og-image.png' }: SEOProps) {
  const fullTitle = title.includes('Draft Legal') ? title : `${title} | Draft Legal`
  const url = `${SITE_URL}${path}`
  const fullOg = ogImage.startsWith('http') ? ogImage : `${SITE_URL}${ogImage}`

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.title = fullTitle
    upsertMeta('meta[name="description"]', 'name', 'description', description)
    upsertMeta('meta[property="og:title"]', 'property', 'og:title', fullTitle)
    upsertMeta('meta[property="og:description"]', 'property', 'og:description', description)
    upsertMeta('meta[property="og:url"]', 'property', 'og:url', url)
    upsertMeta('meta[property="og:type"]', 'property', 'og:type', 'website')
    upsertMeta('meta[property="og:image"]', 'property', 'og:image', fullOg)
    upsertMeta('meta[name="twitter:card"]', 'name', 'twitter:card', 'summary_large_image')
    upsertMeta('meta[name="twitter:title"]', 'name', 'twitter:title', fullTitle)
    upsertMeta('meta[name="twitter:description"]', 'name', 'twitter:description', description)
    upsertMeta('meta[name="twitter:image"]', 'name', 'twitter:image', fullOg)
    upsertLink('canonical', url)

    if (schema) {
      const arr = Array.isArray(schema) ? schema : [schema]
      arr.forEach((s, i) => upsertScript(`ld-${i}`, JSON.stringify(s)))
    }
  }, [fullTitle, description, url, fullOg, schema])

  return null
}

export const orgSchema = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Draft Legal',
  url: SITE_URL,
  logo: `${SITE_URL}/favicon.svg`,
  description:
    'Open-source, agent-first contract lifecycle management. AGPL-3.0 licensed, self-host the same code we run.',
  sameAs: ['https://github.com/AniketTati/draft-legal'],
}

export const softwareSchema = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Draft Legal',
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Web, Linux, Docker',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  description:
    'Agent-first contract lifecycle management: 12 AI agents handle intake, review, drafting, negotiation, approvals and post-signature obligations, with e-signature built in.',
}

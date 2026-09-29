import { Hero } from '@/components/sections/Hero'
import { HeroProductPreview } from '@/components/sections/HeroProductPreview'
import { BentoFeatures } from '@/components/sections/BentoFeatures'
import { AgentGrid } from '@/components/sections/AgentGrid'
import { LifecycleScroller } from '@/components/sections/LifecycleScroller'
import { OpenSourceBlock } from '@/components/sections/OpenSourceBlock'
import { CompareTeaser } from '@/components/sections/CompareTeaser'
import { TrustStrip } from '@/components/sections/TrustStrip'
import { Faq } from '@/components/sections/Faq'
import { CtaStrip } from '@/components/sections/CtaStrip'
import { homeFaqs } from '@/content/faqs'
import { SEO, orgSchema, softwareSchema } from '@/lib/seo'

export default function Home() {
  return (
    <>
      <SEO
        title="Open-source, agent-first CLM"
        description="12 AI agents handle intake, review, drafting, negotiation, approvals and obligations, with e-signature built in. AGPL-3.0 licensed, self-host the same code we run."
        path="/"
        schema={[orgSchema, softwareSchema]}
      />
      <Hero />
      <HeroProductPreview />
      <BentoFeatures />
      <AgentGrid />
      <LifecycleScroller />
      <OpenSourceBlock />
      <CompareTeaser />
      <TrustStrip />
      <Faq items={homeFaqs} />
      <CtaStrip />
    </>
  )
}

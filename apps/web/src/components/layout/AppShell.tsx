import { Suspense } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { Breadcrumbs } from './Breadcrumbs'
import { SideAgentRail } from '@/components/agent/SideAgentRail'
import { PageLoading } from '@/components/common/PageLoading'

// U.4.5 — legacy ChatPanel modal + AGENT_SIDE_PANEL_V2 feature flag deleted
// (doc 32 §11b items 7+10). Final state: rail is the AI surface on every
// non-/agent route, no fallback. The /agent route runs the studio.
export function AppShell() {
  const location = useLocation()
  const onAgentRoute = location.pathname.startsWith('/agent')

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0">
        <Header />
        <Breadcrumbs />
        <main className="flex-1 overflow-y-auto">
          {/* Keeps the rail and header on screen while a page's code loads. */}
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      {!onAgentRoute && <SideAgentRail />}
    </div>
  )
}

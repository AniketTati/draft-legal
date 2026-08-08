import { Routes, Route, Navigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '@/store/auth'
import { api } from '@/lib/api'
import { AppShell } from '@/components/layout/AppShell'
import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard'
import { LoginPage } from '@/pages/LoginPage'
import { RegisterPage } from '@/pages/RegisterPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { AgentHomePage } from '@/pages/AgentHomePage'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { ContractsPage } from '@/pages/ContractsPage'
import { ContractDetailPage } from '@/pages/ContractDetailPage'
import { RequestsPage } from '@/pages/RequestsPage'
import { CounterpartiesPage } from '@/pages/CounterpartiesPage'
import { CounterpartyDetailPage } from '@/pages/CounterpartyDetailPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { TemplatesPage } from '@/pages/TemplatesPage'
import { ClausesPage } from '@/pages/ClausesPage'
import { PlaybookPage } from '@/pages/PlaybookPage'
import { ApprovalsPage } from '@/pages/ApprovalsPage'
import { SignaturesPage } from '@/pages/SignaturesPage'
import { ObligationsPage } from '@/pages/ObligationsPage'
import { RenewalsPage } from '@/pages/RenewalsPage'
import { InvoicesPage } from '@/pages/InvoicesPage'
import { DiligenceRoomsPage } from '@/pages/DiligenceRoomsPage'
import { DiligenceRoomDetailPage } from '@/pages/DiligenceRoomDetailPage'
import { AnalyticsPage } from '@/pages/AnalyticsPage'
import { ExternalPortalPage } from '@/pages/ExternalPortalPage'
import { SignerPortal } from '@/pages/SignerPortal'
import { PrivacyPage } from '@/pages/legal/PrivacyPage'
import { TermsPage } from '@/pages/legal/TermsPage'
import { StatusPage } from '@/pages/legal/StatusPage'
import { AdminUsersPage } from '@/pages/AdminUsersPage'
import { AdminRolesPage } from '@/pages/AdminRolesPage'
import { AdminOrgPage } from '@/pages/AdminOrgPage'
import { AdminIntegrationsPage } from '@/pages/AdminIntegrationsPage'
import { AdminSkillsPage } from '@/pages/AdminSkillsPage'
import { ReviewQueuePage } from '@/pages/ReviewQueuePage'
import { MattersPage } from '@/pages/MattersPage'
import { MatterDetailPage } from '@/pages/MatterDetailPage'
import { ProfilePage } from '@/pages/ProfilePage'
import { AcceptInvitePage } from '@/pages/AcceptInvitePage'
import { TeamPage } from '@/pages/TeamPage'
import { Toaster } from '@/components/common/Toaster'

function OnboardingGate({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)

  const { data: org } = useQuery({
    queryKey: ['organization'],
    queryFn: () => api.get('/organization').then((r) => r.data),
    enabled: isAuthenticated,
    staleTime: 60_000,
  })

  const isAdmin = (user?.roles as string[] | undefined)?.includes('ADMIN')
  const onboardingCompleted = org?.settings?.onboardingCompleted === true

  if (isAdmin && org && !onboardingCompleted) {
    return (
      <>
        {children}
        <OnboardingWizard />
      </>
    )
  }

  return <>{children}</>
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <>
    <Toaster />
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/accept-invite/:token" element={<AcceptInvitePage />} />
      <Route path="/portal/:portalToken" element={<ExternalPortalPage />} />
      {/* Public legal + status — no auth required. Linked from sign-in,
          signer portal, register flow, and the in-app footer. */}
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms"   element={<TermsPage />} />
      <Route path="/status"  element={<StatusPage />} />
      {/*
        B.5.15 — Signer portal (docs/26 State 5). UI-only stub until
        A.4 ships the real signature_requests backend; the route +
        document fetch + sticky CTA are all production shape so
        rollout is a single commit.
      */}
      <Route path="/sign/:token" element={<SignerPortal />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <OnboardingGate>
              <AppShell />
            </OnboardingGate>
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        {/* P7.3 — Genspark-style full-screen agent home. Same threads as
            the side rail (single source of truth); the dashboard remains
            the operational home (per docs/29 §3 Pattern B+E). */}
        <Route path="agent" element={
          <ErrorBoundary label="the Assistant">
            <AgentHomePage />
          </ErrorBoundary>
        } />
        <Route path="contracts" element={<ContractsPage />} />
        <Route path="contracts/:id" element={<ContractDetailPage />} />
        <Route path="requests" element={<RequestsPage />} />
        <Route path="counterparties" element={<CounterpartiesPage />} />
        {/* P7.4.5 — F-49: Counterparty profile detail page (was missing). */}
        <Route path="counterparties/:id" element={<CounterpartyDetailPage />} />
        <Route path="templates" element={<TemplatesPage />} />
        <Route path="clauses" element={<ClausesPage />} />
        <Route path="playbook" element={<PlaybookPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="signatures" element={<SignaturesPage />} />
        <Route path="obligations" element={<ObligationsPage />} />
        <Route path="renewals" element={<RenewalsPage />} />
        <Route path="invoices" element={<InvoicesPage />} />
        <Route path="diligence" element={<DiligenceRoomsPage />} />
        <Route path="diligence/:id" element={<DiligenceRoomDetailPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="admin/users" element={<AdminUsersPage />} />
        <Route path="admin/roles" element={<AdminRolesPage />} />
        <Route path="admin/org" element={<AdminOrgPage />} />
        <Route path="admin/integrations" element={<AdminIntegrationsPage />} />
        <Route path="admin/skills" element={<AdminSkillsPage />} />
        {/* D.4.3 — convenience alias matching docs/30 §4.4 wording */}
        <Route path="settings/skills" element={<AdminSkillsPage />} />
        {/* P2.5 — HITL review queue for low-confidence extractions */}
        <Route path="review-queue" element={<ReviewQueuePage />} />
        {/* P4.2 — Matter list + workspace */}
        <Route path="matters" element={<MattersPage />} />
        <Route path="matters/:id" element={<MatterDetailPage />} />
        <Route path="team" element={<TeamPage />} />
        <Route path="profile" element={<ProfilePage />} />
        {/* Catch-all, LAST. Without it an unmatched URL rendered AppShell's
            <Outlet/> as null -- full chrome around a blank page, which reads as
            a broken app rather than a bad link and cannot be diagnosed from a
            user's description. */}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
    </>
  )
}

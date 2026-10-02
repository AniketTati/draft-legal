import { lazy, Suspense, type ComponentType } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '@/store/auth'
import { api } from '@/lib/api'
import { AppShell } from '@/components/layout/AppShell'
import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard'
import { LoginPage } from '@/pages/LoginPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { Toaster } from '@/components/common/Toaster'
import { PageLoading } from '@/components/common/PageLoading'

// Pages load when first visited, not with the app: every page in the entry
// chunk had pushed it past its size budget (scripts/check-bundle-size.mjs).
// Sign-in, the dashboard and not-found stay in it, as the pages people land on.
function page<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  return lazy(() => load().then(m => ({ default: m[name] })))
}
const SsoCallbackPage = page(() => import('@/pages/SsoCallbackPage'), 'SsoCallbackPage')
const EmbedContractPage = page(() => import('@/pages/EmbedContractPage'), 'EmbedContractPage')
const RegisterPage = page(() => import('@/pages/RegisterPage'), 'RegisterPage')
const AgentHomePage = page(() => import('@/pages/AgentHomePage'), 'AgentHomePage')
const ContractsPage = page(() => import('@/pages/ContractsPage'), 'ContractsPage')
const ContractDetailPage = page(() => import('@/pages/ContractDetailPage'), 'ContractDetailPage')
const ContractWorkspacePage = page(() => import('@/pages/ContractWorkspacePage'), 'ContractWorkspacePage')
const RequestsPage = page(() => import('@/pages/RequestsPage'), 'RequestsPage')
const CounterpartiesPage = page(() => import('@/pages/CounterpartiesPage'), 'CounterpartiesPage')
const CounterpartyDetailPage = page(() => import('@/pages/CounterpartyDetailPage'), 'CounterpartyDetailPage')
const SettingsPage = page(() => import('@/pages/SettingsPage'), 'SettingsPage')
const TemplatesPage = page(() => import('@/pages/TemplatesPage'), 'TemplatesPage')
const ClausesPage = page(() => import('@/pages/ClausesPage'), 'ClausesPage')
const PlaybookPage = page(() => import('@/pages/PlaybookPage'), 'PlaybookPage')
const ApprovalsPage = page(() => import('@/pages/ApprovalsPage'), 'ApprovalsPage')
const SignaturesPage = page(() => import('@/pages/SignaturesPage'), 'SignaturesPage')
const ObligationsPage = page(() => import('@/pages/ObligationsPage'), 'ObligationsPage')
const RenewalsPage = page(() => import('@/pages/RenewalsPage'), 'RenewalsPage')
const InvoicesPage = page(() => import('@/pages/InvoicesPage'), 'InvoicesPage')
const DiligenceRoomsPage = page(() => import('@/pages/DiligenceRoomsPage'), 'DiligenceRoomsPage')
const DiligenceRoomDetailPage = page(() => import('@/pages/DiligenceRoomDetailPage'), 'DiligenceRoomDetailPage')
const AnalyticsPage = page(() => import('@/pages/AnalyticsPage'), 'AnalyticsPage')
const ExternalPortalPage = page(() => import('@/pages/ExternalPortalPage'), 'ExternalPortalPage')
const SignerPortal = page(() => import('@/pages/SignerPortal'), 'SignerPortal')
const PrivacyPage = page(() => import('@/pages/legal/PrivacyPage'), 'PrivacyPage')
const TermsPage = page(() => import('@/pages/legal/TermsPage'), 'TermsPage')
const StatusPage = page(() => import('@/pages/legal/StatusPage'), 'StatusPage')
const AdminUsersPage = page(() => import('@/pages/AdminUsersPage'), 'AdminUsersPage')
const AdminRolesPage = page(() => import('@/pages/AdminRolesPage'), 'AdminRolesPage')
const AdminOrgPage = page(() => import('@/pages/AdminOrgPage'), 'AdminOrgPage')
const AdminIntegrationsPage = page(() => import('@/pages/AdminIntegrationsPage'), 'AdminIntegrationsPage')
const AdminSkillsPage = page(() => import('@/pages/AdminSkillsPage'), 'AdminSkillsPage')
const AdminAnalysisHealthPage = page(() => import('@/pages/AdminAnalysisHealthPage'), 'AdminAnalysisHealthPage')
const ReviewQueuePage = page(() => import('@/pages/ReviewQueuePage'), 'ReviewQueuePage')
const MattersPage = page(() => import('@/pages/MattersPage'), 'MattersPage')
const MatterDetailPage = page(() => import('@/pages/MatterDetailPage'), 'MatterDetailPage')
const ProfilePage = page(() => import('@/pages/ProfilePage'), 'ProfilePage')
const AcceptInvitePage = page(() => import('@/pages/AcceptInvitePage'), 'AcceptInvitePage')
const TeamPage = page(() => import('@/pages/TeamPage'), 'TeamPage')

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
    <Suspense fallback={<PageLoading />}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* docs/41 Part 20 — where single sign-on lands. */}
      <Route path="/login/sso" element={<SsoCallbackPage />} />
      {/* docs/41 Part 17 — the read-only preview Salesforce frames, by token. */}
      <Route path="/embed/contracts/:id" element={<EmbedContractPage />} />
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
      {/* docs/41 Part 16 (C2) — the contract workspace is full screen: no app rail. */}
      <Route
        path="/contracts/:id/workspace"
        element={
          <ProtectedRoute>
            <ErrorBoundary label="the workspace">
              <ContractWorkspacePage />
            </ErrorBoundary>
          </ProtectedRoute>
        }
      />
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
        <Route path="admin/analysis" element={<AdminAnalysisHealthPage />} />
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
    </Suspense>
    </>
  )
}

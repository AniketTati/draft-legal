import { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { LogOut, User, ChevronDown, Search, Settings } from 'lucide-react'
import { useAuthStore } from '@/store/auth'
import { NotificationBell } from '@/components/approvals/NotificationBell'
import { GlobalSearch } from '@/components/common/GlobalSearch'
import { Kbd } from '@/components/ui/primitives'

// U.8 — derive a 1- or 2-letter avatar initial from the user's display
// name. "Maya Goldberg" → "MG"; "alex" → "A"; "" → "?".
function initialsOf(name?: string): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase()
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase()
}

// U.4.3 — onChatToggle prop kept optional for back-compat with AppShell;
// the "AI Assistant" pill it powered is deleted (doc 32 §11b item 7).
interface HeaderProps {
  onChatToggle?: () => void
}

export function Header(_props: HeaderProps) {
  const { user, logout } = useAuthStore()
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close menu on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false)
      }
    }
    if (showUserMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showUserMenu])

  // B.6.25 — global ⌘/ (or Ctrl-/) opens the navigate-palette. We
  // pick the slash so we don't conflict with the contract-scoped
  // ⌘K Ask AI palette.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)

  return (
    <header className="h-header border-b border-border bg-card flex items-center justify-between px-6 shrink-0">
      {/* B.6.25 — global search affordance (left side of header). Click
          or press ⌘/ to open. Kept visually distinct from the AI
          assistant so users don't conflate "find" with "ask". */}
      <button
        type="button"
        onClick={() => setSearchOpen(true)}
        data-testid="global-search-trigger"
        className="inline-flex h-8 items-center gap-2 rounded-md border border-paper-200 bg-paper-50 px-[11px] text-[12.5px] text-ink-400 hover:bg-paper-100 hover:text-ink-700 transition-colors min-w-[16rem]"
        aria-label="Open global search"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left">Search contracts, counterparties…</span>
        {/* Kbd's own ground is paper-50 — on a paper-50 field it needs the card
            surface behind it to stay legible. */}
        <Kbd className="bg-card text-[10px]">{isMac ? '⌘/' : 'Ctrl+/'}</Kbd>
      </button>
      <div className="flex items-center gap-2">
        {/* U.4.3 — header agent-pill deleted. The right rail handles
            its own expand/collapse; ⌘K from anywhere focuses the rail
            composer; the sidebar Assistant link goes to /agent. */}
        <NotificationBell />

        {/* User dropdown */}
        <div className="relative ml-2" ref={menuRef}>
          <button
            onClick={() => setShowUserMenu(prev => !prev)}
            data-testid="user-menu-trigger"
            className="flex items-center gap-2 text-[12.5px] text-ink-700 hover:text-ink-950 transition-colors rounded-full pl-1 pr-2 py-1 hover:bg-paper-100"
            aria-label="Account menu"
          >
            {/* The avatar is a person, not a machine — indigo belongs to agent
                surfaces only, so the initials read as neutral paper + ink. */}
            <span
              aria-hidden
              className="size-7 rounded-full bg-paper-100 text-ink-700 flex items-center justify-center text-[10.5px] font-semibold tracking-wide ring-1 ring-paper-200"
            >
              {initialsOf(user?.name)}
            </span>
            <span className="max-w-[8rem] truncate hidden sm:inline">{user?.name}</span>
            <ChevronDown size={12} className="text-ink-400" />
          </button>

          {showUserMenu && (
            <div
              data-testid="user-menu"
              className="absolute right-0 top-full mt-1.5 w-60 bg-card rounded-card border border-paper-200 shadow-e2 z-20 py-1 overflow-hidden"
              role="menu"
            >
              {/* Identity block — answers "am I logged in as the right person?" */}
              <div className="px-3 pt-3 pb-3 border-b border-border flex items-center gap-2.5">
                <span
                  aria-hidden
                  className="size-9 rounded-full bg-paper-100 text-ink-700 flex items-center justify-center text-dense font-semibold tracking-wide ring-1 ring-paper-200 shrink-0"
                >
                  {initialsOf(user?.name)}
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-ink-950 truncate" data-testid="user-menu-name">
                    {user?.name ?? 'Signed-in user'}
                  </p>
                  <p className="text-[11px] text-ink-500 truncate" data-testid="user-menu-email">
                    {user?.email ?? ''}
                  </p>
                </div>
              </div>

              <div className="py-1">
                <Link
                  to="/profile"
                  onClick={() => setShowUserMenu(false)}
                  data-testid="user-menu-profile"
                  className="flex items-center gap-2 px-3 py-2 text-[12.5px] text-ink-700 hover:text-ink-950 hover:bg-paper-100 transition-colors"
                  role="menuitem"
                >
                  <User size={14} className="text-ink-400" />
                  Profile
                </Link>
                <Link
                  to="/settings"
                  onClick={() => setShowUserMenu(false)}
                  data-testid="user-menu-settings"
                  className="flex items-center gap-2 px-3 py-2 text-[12.5px] text-ink-700 hover:text-ink-950 hover:bg-paper-100 transition-colors"
                  role="menuitem"
                >
                  <Settings size={14} className="text-ink-400" />
                  Settings
                </Link>
              </div>

              <div className="border-t border-border py-1">
                {/* Red survives here: sign-out is the one item in this menu you
                    do not want to hit by accident. It is the marked exit, not
                    decoration. */}
                <button
                  onClick={() => {
                    setShowUserMenu(false)
                    // B.6.20 — logout is a deliberate action; after it
                    // we always send the user to /login fresh (no next
                    // param). Restore-URL only applies when the user
                    // was forced out by token expiry.
                    logout()
                    window.location.href = '/login'
                  }}
                  data-testid="user-menu-logout"
                  className="w-full flex items-center gap-2 px-3 py-2 text-[12.5px] text-risk-700 hover:bg-risk-50 transition-colors"
                  role="menuitem"
                >
                  <LogOut size={14} />
                  Sign out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </header>
  )
}

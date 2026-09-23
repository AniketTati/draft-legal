import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import axios from 'axios'
import { singleFlight } from '@/lib/single-flight'
import type { User } from '@clm/types'

interface AuthState {
  user: User | null
  accessToken: string | null
  refreshToken: string | null
  isAuthenticated: boolean

  login: (email: string, password: string) => Promise<void>
  register: (data: { email: string; password: string; name: string; orgName: string }) => Promise<void>
  refresh: () => Promise<void>
  logout: () => void
  setUser: (user: User) => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,

      login: async (email, password) => {
        const { data } = await axios.post('/api/v1/auth/login', { email, password })
        set({
          user: data.user,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          isAuthenticated: true,
        })
      },

      register: async (body) => {
        const { data } = await axios.post('/api/v1/auth/register', {
          ...body,
          orgName: body.orgName,
        })
        set({
          user: data.user,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          isAuthenticated: true,
        })
      },

      // X48 — one refresh at a time. Every request that met an expired access
      // token refreshed with the same refresh token, and the server rotates it
      // on use: each refresh after the first was refused, and the app logged
      // the user out.
      // The shared refresh has a time limit, so a hung one can't hold every
      // later request, and it doesn't write one session's tokens over another's
      // if the user signed out (or someone else signed in) while it ran.
      refresh: singleFlight(async () => {
        const { refreshToken } = get()
        if (!refreshToken) throw new Error('No refresh token')
        const { data } = await axios.post('/api/v1/auth/refresh', { refreshToken }, { timeout: 15_000 })
        if (get().refreshToken !== refreshToken) return
        set({ accessToken: data.accessToken, refreshToken: data.refreshToken })
      }),

      logout: () => {
        const { accessToken } = get()
        if (accessToken) {
          axios.post('/api/v1/auth/logout', {}, {
            headers: { Authorization: `Bearer ${accessToken}` },
          }).catch(() => {})
        }
        set({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false })
      },

      setUser: (user) => set({ user }),
    }),
    {
      name: 'clm-auth',
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
)

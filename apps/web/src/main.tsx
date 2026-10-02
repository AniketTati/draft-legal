import React from 'react'
import ReactDOM from 'react-dom/client'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import App from './App.tsx'
import './index.css'
import { apiErrorMessage, shouldToastMutationError } from './lib/api'
import { toast } from './components/common/Toaster'

const queryClient = new QueryClient({
  // docs/41 P0.7 — a write that failed says so, in the server's words.
  // Several actions (the playbook redline start, approval decisions, request
  // reject) had no error display at all: the button just reset.
  mutationCache: new MutationCache({
    onError: (err, _vars, _ctx, mutation) => {
      if (shouldToastMutationError(err, mutation)) toast.error(apiErrorMessage(err))
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 min
      retry: 1,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
)

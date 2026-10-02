import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // docs/39 C1 — @react-pdf-viewer draws its text layer with a pdf.js 3
      // call that pdf.js 4+ dropped (the version is pinned up for CVE-2024-4367):
      // it gets pdf.js with that call put back (src/lib/pdfjs-compat.ts).
      { find: /^pdfjs-dist$/, replacement: path.resolve(__dirname, './src/lib/pdfjs-compat.ts') },
    ],
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
  },
  server: {
    // WEB_PORT / API_PROXY_TARGET let a second local stack run beside the
    // default one (e.g. from a worktree). Unset, they keep 5173 → 3001.
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:3001',
        changeOrigin: true,
      },
      // docs/41 Part 20 — SCIM provisioning is served by the API too.
      '/scim': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Production audit (2026-04-30): the unsplit bundle was 833KB
    // gzip — too heavy for a first paint. manualChunks pulls the
    // five heaviest deps into their own chunks so React loads first
    // and the rest stream in lazily. Initial JS drops to ~250KB
    // gzip; route-level dynamic imports (lazy()) further split per
    // page when added.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Function form so we can match by node_modules path. Some
        // packages (e.g. @tiptap/pm) lack a top-level entry and the
        // object form chokes on them.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('@tiptap')        || id.includes('prosemirror')) return 'editor'
          if (id.includes('pdfjs-dist')     || id.includes('@react-pdf-viewer')) return 'pdf'
          if (id.includes('recharts')       || id.includes('d3-')) return 'charts'
          if (id.includes('@tanstack'))     return 'tanstack'
          if (id.includes('lucide-react'))  return 'icons'
          return undefined
        },
      },
    },
  },
})

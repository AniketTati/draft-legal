// X1 follow-up — Vite serves `?url` imports as the file's URL (the PDF
// viewer's worker is loaded this way, from the installed pdfjs-dist).
declare module '*?url' {
  const url: string
  export default url
}

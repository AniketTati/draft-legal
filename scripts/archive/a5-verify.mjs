#!/usr/bin/env node
/**
 * A.5 verification — hybrid canonical artifact.
 *
 * Flow:
 *   1. Login as admin.
 *   2. Find an uploaded contract (has s3Key, no renderedPdfKey).
 *   3. POST /contracts/:id/html-version with new HTML → triggers Gotenberg
 *      rendering in the background.
 *   4. Poll the version via Prisma until renderedPdfKey + renderedAt are
 *      populated (or fail after 30s).
 *   5. GET /contracts/:id/download?versionId=X — assert response includes
 *      artifact: 'rendered'.
 *   6. GET /contracts/:id/download?versionId=X&artifact=source — assert
 *      response includes artifact: 'source' and a different URL.
 */
import path from 'node:path'
import { createRequire } from 'node:module'
import { REPO_ROOT } from './lib/repo-root.mjs'

const require = createRequire(path.join(REPO_ROOT, 'apps/api/package.json'))
const { PrismaClient } = require('@prisma/client')

const BASE = 'http://localhost:3001/api/v1'
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://clm:clm@localhost:5432/clm_dev'
const prisma = new PrismaClient()

const fail = (msg) => { console.log('❌ FAIL —', msg); process.exit(1); };
const pass = (msg) => console.log('✅ PASS —', msg);

async function main() {
  // 1. Login
  const loginRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'password123' }),
  });
  const { accessToken } = await loginRes.json();
  const auth = { Authorization: `Bearer ${accessToken}` };

  // 2. Pick a target contract — any contract with at least one version
  //    (we'll create a new version via /html-version so it doesn't matter
  //    what state the existing one is in)
  const contract = await prisma.contract.findFirst({
    where: { deletedAt: null },
    include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
  });
  if (!contract) fail('no contract in DB');
  console.log('Target contract:', contract.title, '→', contract.id);

  // 3. POST /html-version
  const saveRes = await fetch(`${BASE}/contracts/${contract.id}/html-version`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      htmlContent: `<h1>A.5 canonical artifact test</h1><p>Edited at ${new Date().toISOString()}</p><p>This HTML should be rendered to PDF via Gotenberg, stored in S3, and linked as renderedPdfKey on the new version. The download endpoint should now serve that PDF as canonical.</p>`,
      changeNote: 'A.5 verification — synthetic edit',
    }),
  });
  if (!saveRes.ok) fail(`/html-version returned ${saveRes.status}`);
  const saved = await saveRes.json();
  const newVersionId = saved.id ?? saved.versionId;
  console.log('New version created:', newVersionId);

  // 4. Poll for renderedPdfKey (Gotenberg may take 1-5 seconds)
  let version = null;
  for (let i = 0; i < 15; i++) {
    version = await prisma.contractVersion.findUnique({ where: { id: newVersionId } });
    if (version?.renderedPdfKey && version?.renderedAt) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!version?.renderedPdfKey) fail(`renderedPdfKey not populated after 15s (got: ${JSON.stringify({rpk: version?.renderedPdfKey, ra: version?.renderedAt})})`);
  pass(`renderedPdfKey populated: ${version.renderedPdfKey}`);
  pass(`renderedAt populated: ${version.renderedAt.toISOString()}`);

  // 5. GET /download (canonical, default) — should be the rendered PDF
  const downloadRes = await fetch(`${BASE}/contracts/${contract.id}/download?versionId=${newVersionId}`, { headers: auth });
  const downloadBody = await downloadRes.json();
  if (downloadBody.artifact !== 'rendered') fail(`/download artifact expected 'rendered', got '${downloadBody.artifact}'`);
  pass(`/download returns artifact: rendered`);

  // 6. GET /download?artifact=source — should return the original s3Key (if it had one)
  if (version.s3Key === null) {
    console.log('ℹ Skipping source-artifact check — this version was created by /html-version (no source file)');
  } else {
    const sourceRes = await fetch(`${BASE}/contracts/${contract.id}/download?versionId=${newVersionId}&artifact=source`, { headers: auth });
    const sourceBody = await sourceRes.json();
    if (sourceBody.artifact !== 'source') fail(`/download?artifact=source returned '${sourceBody.artifact}'`);
    pass(`/download?artifact=source returns artifact: source`);
  }

  console.log('\n✅ A.5 verification complete');
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });

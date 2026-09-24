/**
 * Signing certificate management (Wave 2.7, 2026-07).
 *
 * Provides the PKCS#12 (cert + private key) used to apply a real, tamper-
 * evident PAdES signature to executed contracts (see lib/pades-signing.ts).
 *
 * Production: supply the cert out-of-band via SIGNING_CERT_P12_BASE64 +
 * SIGNING_CERT_PASSPHRASE (stored in Secret Manager). Refuses to fall back to
 * a self-signed dev cert in production.
 *
 * Dev: generates a self-signed cert once and persists it to
 * .dev-signing-cert.p12 (gitignored) so signed PDFs verify consistently across
 * restarts. This is a real cryptographic signature — it just chains to an
 * untrusted (self-signed) root, which is fine for local verification.
 */
import forge from 'node-forge'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isStrict } from './runtime-mode.js'

export interface SigningP12 {
  p12: Buffer
  passphrase: string
}

const DEV_CERT_FILE = join(process.cwd(), '.dev-signing-cert.p12')
const DEV_PASSPHRASE = 'draftlegal-dev-signing'

let cached: SigningP12 | null = null

/** Build a self-signed X.509 cert + RSA key, packaged as a PKCS#12 buffer. */
function generateSelfSignedP12(passphrase: string): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8))
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10)
  const attrs = [
    { name: 'commonName', value: 'draftLegal Signing Authority' },
    { name: 'organizationName', value: 'draftLegal' },
    { shortName: 'OU', value: 'e-Signature' },
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, keyCertSign: true },
    { name: 'extKeyUsage', emailProtection: true },
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, { algorithm: '3des' })
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary')
}

/** Resolve the signing PKCS#12 for this environment (cached per process). */
export function getSigningP12(): SigningP12 {
  if (cached) return cached

  const b64 = process.env.SIGNING_CERT_P12_BASE64
  const pass = process.env.SIGNING_CERT_PASSPHRASE
  if (b64 && pass) {
    cached = { p12: Buffer.from(b64, 'base64'), passphrase: pass }
    return cached
  }

  // Y5 — required in any NODE_ENV but development and test: a staging or
  // preview install signed with a self-signed certificate.
  if (isStrict()) {
    throw new Error(
      '[signing-cert] SIGNING_CERT_P12_BASE64 + SIGNING_CERT_PASSPHRASE are required outside ' +
      'development and tests to apply tamper-evident e-signatures. Generate a signing cert and store ' +
      'it in Secret Manager.'
    )
  }

  // Dev: reuse a persisted self-signed cert, or generate one.
  if (existsSync(DEV_CERT_FILE)) {
    cached = { p12: readFileSync(DEV_CERT_FILE), passphrase: DEV_PASSPHRASE }
    return cached
  }
  const p12 = generateSelfSignedP12(DEV_PASSPHRASE)
  try {
    writeFileSync(DEV_CERT_FILE, p12, { mode: 0o600 })
  } catch {
    /* read-only fs — cert stays in memory for this process */
  }
  console.warn(
    '[signing-cert] generated a self-signed dev signing cert (.dev-signing-cert.p12). ' +
    'Signatures are cryptographically valid but chain to an untrusted root. Set ' +
    'SIGNING_CERT_P12_BASE64 + SIGNING_CERT_PASSPHRASE for production.'
  )
  cached = { p12, passphrase: DEV_PASSPHRASE }
  return cached
}

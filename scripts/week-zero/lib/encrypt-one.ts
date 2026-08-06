/**
 * Encrypt one value with the API's own BYOK encryption, so a check script can
 * write an OrgAiKey row that getByokKey() will actually decrypt.
 *
 * Run through the API workspace so the AI_KEY_ENCRYPTION_KEY env and the
 * module resolution match production:
 *   cd apps/api && ./node_modules/.bin/tsx --env-file=../../.env \
 *     ../../scripts/week-zero/lib/encrypt-one.ts <plaintext>
 */
import { encrypt } from '../../../apps/api/src/lib/encryption.js'

const value = process.argv[2]
if (!value) {
  console.error('usage: encrypt-one.ts <plaintext>')
  process.exit(1)
}
process.stdout.write(encrypt(value))

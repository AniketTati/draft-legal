/**
 * Object storage for integration tests, held in memory: CI runs no MinIO.
 * Stands in for `s3` from lib/storage.ts:
 *
 *   vi.mock('../lib/storage.js', async importOriginal => ({
 *     ...(await importOriginal<typeof import('../lib/storage.js')>()),
 *     s3: (await import('../test-support/fake-s3.js')).fakeS3(),
 *   }))
 *
 * Puts and gets only. A get's body reads both ways the code reads one: as an
 * async iterable (pdf-signing) and with transformToByteArray (external-edit).
 * Any other command throws, so a new use of storage fails loudly here.
 */
type Command = { constructor: { name: string }; input: { Key: string; Body?: Uint8Array | string } }

export function fakeS3() {
  const objects = new Map<string, Uint8Array>()
  return {
    objects,
    async send(cmd: Command) {
      const name = cmd.constructor.name
      if (name === 'PutObjectCommand') {
        const body = cmd.input.Body ?? new Uint8Array()
        objects.set(cmd.input.Key, typeof body === 'string' ? Buffer.from(body) : body)
        return {}
      }
      if (name === 'GetObjectCommand') {
        const bytes = objects.get(cmd.input.Key)
        if (!bytes) throw Object.assign(new Error(`NoSuchKey: ${cmd.input.Key}`), { name: 'NoSuchKey' })
        return {
          Body: {
            async *[Symbol.asyncIterator]() { yield Buffer.from(bytes) },
            transformToByteArray: async () => bytes,
          },
        }
      }
      throw new Error(`fake-s3: ${name} is not faked`)
    },
  }
}

/** Wave 3.7 / X65 review — whom a sequential signature notifies next. */
import { describe, it, expect } from 'vitest'
import { nextSignersToNotify } from './signing-order.js'

const signer = (id: string, signOrder: number, status = 'PENDING') => ({ id, signOrder, status })

describe('nextSignersToNotify', () => {
  it('the next group, once the signer\'s own group has finished', () => {
    const signers = [signer('a', 1, 'SIGNED'), signer('b', 2), signer('c', 2), signer('d', 3)]
    expect(nextSignersToNotify({ status: 'PENDING', signers }, 1).map(s => s.id)).toEqual(['b', 'c'])
  })

  it('nobody while a sibling in the signer\'s group is still to sign, or when all have signed', () => {
    expect(nextSignersToNotify({ status: 'PENDING', signers: [signer('a', 1, 'SIGNED'), signer('b', 1), signer('c', 2)] }, 1)).toEqual([])
    expect(nextSignersToNotify({ status: 'PENDING', signers: [signer('a', 1, 'SIGNED')] }, 1)).toEqual([])
  })

  it('nobody once a void, decline or expiry has ended the request', () => {
    const signers = [signer('a', 1, 'SIGNED'), signer('b', 2)]
    for (const status of ['VOIDED', 'EXPIRED', 'COMPLETED']) {
      expect(nextSignersToNotify({ status, signers }, 1)).toEqual([])
    }
  })
})

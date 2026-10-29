import { describe, expect, it } from 'vitest'
import { Scrypt } from '@adonisjs/hash/drivers/scrypt'
import { hashWorkerPassword, verifyWorkerPassword, workerPasswordNeedsRehash } from '../../workers/auth/password'

describe('Worker password compatibility with installed Nuxt/Adonis', () => {
  const legacy = new Scrypt({})

  it('verifies existing Nuxt hashes without changing UTF-8 password semantics', async () => {
    const password = 'Frase de prueba ñ🔐 con espacios'
    const encoded = await legacy.make(password)
    expect(await verifyWorkerPassword(encoded, password)).toBe(true)
    expect(await verifyWorkerPassword(encoded, `${password} `)).toBe(false)
    expect(workerPasswordNeedsRehash(encoded)).toBe(false)
  })

  it('generates random salted hashes accepted by the legacy verifier at the same cost', async () => {
    const first = await hashWorkerPassword('Synthetic-password-42')
    const second = await hashWorkerPassword('Synthetic-password-42')
    expect(first).not.toBe(second)
    expect(first).toMatch(/^\$scrypt\$n=16384,r=8,p=1\$/)
    expect(await legacy.verify(first, 'Synthetic-password-42')).toBe(true)
    expect(await legacy.verify(first, 'wrong')).toBe(false)
    expect(legacy.needsReHash(first)).toBe(false)
  })

  it('accepts bounded historical parameters and requests an upgrade', async () => {
    const historical = await new Scrypt({ cost: 8192 }).make('test-password')
    expect(await verifyWorkerPassword(historical, 'test-password')).toBe(true)
    expect(workerPasswordNeedsRehash(historical)).toBe(true)
    const reordered = historical.replace('n=8192,r=8,p=1', 'p=1,n=8192,r=8')
    expect(await verifyWorkerPassword(reordered, 'test-password')).toBe(true)
  })

  it('rejects malformed, duplicate and excessive parameters before deriving', async () => {
    const encoded = await legacy.make('test-password')
    for (const bad of [
      encoded.replace('n=16384', 'n=999999999'),
      encoded.replace('r=8', 'r=32'),
      encoded.replace('p=1', 'p=999999999'),
      encoded.replace('p=1', 'p=1,n=16384'),
      encoded.replace('n=16384', 'n=3'),
      encoded.replace('scrypt', 'argon2'),
      `${encoded}=`,
      'invalid',
      'x'.repeat(2049)
    ]) {
      expect(await verifyWorkerPassword(bad, 'test-password')).toBe(false)
      expect(workerPasswordNeedsRehash(bad)).toBe(true)
    }
    expect(await verifyWorkerPassword(encoded, '')).toBe(false)
    expect(await verifyWorkerPassword(encoded, 'x'.repeat(129))).toBe(false)
    await expect(hashWorkerPassword('')).rejects.toThrow('invalid_password_length')
  })
})

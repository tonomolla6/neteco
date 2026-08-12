import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

function encryptionKey(encoded: string) {
  const key = Buffer.from(encoded, 'base64')
  if (key.byteLength !== 32) throw new Error('AUTH_ENCRYPTION_KEY must be a base64-encoded 32-byte key')
  return key
}

export function randomOpaqueToken(bytes = 32) {
  if (!Number.isSafeInteger(bytes) || bytes < 16 || bytes > 128) {
    throw new RangeError('Opaque token entropy must be between 16 and 128 bytes')
  }
  return randomBytes(bytes).toString('base64url')
}

export function hashOpaqueToken(token: string, pepper: string) {
  if (!token || !pepper) throw new Error('Token and pepper are required')
  return createHmac('sha256', pepper).update(token, 'utf8').digest('hex')
}

export function opaqueTokenMatches(token: string, expectedHash: string, pepper: string) {
  const actual = Buffer.from(hashOpaqueToken(token, pepper), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
}

export function encryptSecret(plaintext: string, encodedKey: string) {
  if (!plaintext) throw new Error('Cannot encrypt an empty secret')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(encodedKey), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`
}

export function decryptSecret(envelope: string, encodedKey: string) {
  const [version, encodedIv, encodedTag, encodedCiphertext, extra] = envelope.split('.')
  if (version !== 'v1' || !encodedIv || !encodedTag || !encodedCiphertext || extra) {
    throw new Error('Invalid encrypted-secret envelope')
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(encodedKey), Buffer.from(encodedIv, 'base64url'))
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(encodedCiphertext, 'base64url')), decipher.final()]).toString(
    'utf8'
  )
}

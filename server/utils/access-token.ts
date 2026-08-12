import { createHash, timingSafeEqual } from 'node:crypto'

export function hashAccessToken(token: string) {
  return createHash('sha256').update(`neteco-access-v1:${token}`, 'utf8').digest('hex')
}

export function accessTokenMatches(token: string, storedHash: string) {
  const actual = Buffer.from(hashAccessToken(token), 'hex')
  const expected = Buffer.from(storedHash, 'hex')
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
}

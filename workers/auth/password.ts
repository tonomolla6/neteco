import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'

const DEFAULTS = { n: 16384, r: 8, p: 1, saltSize: 16, keyLength: 64 }
const MAX_MEMORY = 32 * 1024 * 1024

function decode(value: string, minimum: number, maximum: number) {
  if (!/^[A-Za-z0-9+/]+$/.test(value)) return null
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length < minimum || bytes.length > maximum || bytes.toString('base64').replace(/=+$/, '') !== value)
    return null
  return bytes
}

function parse(value: string) {
  if (typeof value !== 'string' || value.length > 2048) return null
  const parts = value.split('$')
  if (parts.length !== 5 || parts[0] !== '' || parts[1] !== 'scrypt') return null
  const parameters: Record<string, number> = {}
  for (const parameter of parts[2]!.split(',')) {
    const pair = /^(n|r|p)=([1-9]\d{0,8})$/.exec(parameter)
    if (!pair || parameters[pair[1]!] !== undefined) return null
    parameters[pair[1]!] = Number(pair[2])
  }
  const { n, r, p } = parameters
  if (
    n === undefined ||
    r === undefined ||
    p === undefined ||
    n < 2 ||
    n > 32768 ||
    (n & (n - 1)) !== 0 ||
    r > 32 ||
    p > 4 ||
    128 * n * r + 128 * r * p + 256 * r > MAX_MEMORY
  )
    return null
  const salt = decode(parts[3]!, 8, 1024)
  const hash = decode(parts[4]!, 64, 128)
  return salt && hash ? { n, r, p, salt, hash } : null
}

function derive(password: string, salt: Uint8Array, length: number, parameters: { n: number; r: number; p: number }) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      length,
      { N: parameters.n, r: parameters.r, p: parameters.p, maxmem: MAX_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key))
    )
  })
}

/** Nuxt/Adonis PHC format with the existing defaults; requires nodejs_compat.
 * Input/PHC bounds are checked before invoking the expensive native primitive.
 * Infrastructure errors propagate instead of being reported as bad passwords.
 */
export async function verifyWorkerPassword(encoded: string, password: string) {
  if (typeof password !== 'string' || password.length < 1 || password.length > 128) return false
  const parsed = parse(encoded)
  if (!parsed) return false
  const actual = await derive(password, parsed.salt, parsed.hash.length, parsed)
  return timingSafeEqual(actual, parsed.hash)
}

export async function hashWorkerPassword(password: string) {
  if (typeof password !== 'string' || password.length < 1 || password.length > 128)
    throw new Error('invalid_password_length')
  // Password-strength policy belongs to registration/reset, not this primitive.
  const salt = randomBytes(DEFAULTS.saltSize)
  const hash = await derive(password, salt, DEFAULTS.keyLength, DEFAULTS)
  const base64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '')
  return `$scrypt$n=${DEFAULTS.n},r=${DEFAULTS.r},p=${DEFAULTS.p}$${base64(salt)}$${base64(hash)}`
}

export function workerPasswordNeedsRehash(encoded: string) {
  const parsed = parse(encoded)
  return (
    !parsed ||
    parsed.n !== DEFAULTS.n ||
    parsed.r !== DEFAULTS.r ||
    parsed.p !== DEFAULTS.p ||
    parsed.salt.length !== DEFAULTS.saltSize ||
    parsed.hash.length !== DEFAULTS.keyLength
  )
}

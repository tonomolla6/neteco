import type { ZodType } from 'zod'

/** Stable, client-safe error: `{error:{code}}` at the HTTP boundary. */
export class SecurityControlError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
    this.name = 'SecurityControlError'
  }
}

export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new SecurityControlError('invalid_input', 400)
  return parsed.data
}

const encoder = new TextEncoder()

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
}

export async function hmacSha256Hex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ])
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(text)))
}

/** Constant-time comparison of two equal-length hex strings. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return difference === 0
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)])
    )
  }
  return value
}

/** Hash of the command intent (without its id) used to detect command-id reuse with another payload. */
export async function payloadHash(kind: string, payload: Record<string, unknown>): Promise<string> {
  const { commandId: _ignored, ...rest } = payload
  return sha256Hex(JSON.stringify(canonical({ kind, ...rest })))
}

export function assertSecret(value: string | undefined | null, minLength = 32): string {
  if (typeof value !== 'string' || value.length < minLength) {
    throw new SecurityControlError('security_configuration_missing', 503)
  }
  return value
}

export function plusSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function plusDays(iso: string, days: number): string {
  return plusSeconds(iso, days * 86_400)
}

/**
 * SQL predicate: the identity is active and holds administration.manage right now.
 * `actor` and `now` are parameter placeholders such as '?2' so the same check can be embedded in a write.
 */
export function adminExistsSql(actor: string, now: string): string {
  return `EXISTS(SELECT 1 FROM identities adm WHERE adm.id=${actor} AND adm.status='active'
    AND EXISTS(SELECT 1 FROM identity_roles ar JOIN role_permissions ap ON ap.role_code=ar.role_code
      WHERE ar.identity_id=adm.id AND ap.permission_code='administration.manage'
        AND ar.granted_at<=${now} AND (ar.expires_at IS NULL OR ar.expires_at>${now})))`
}

export async function requireAdmin(database: D1Database, identityId: string, now: string): Promise<void> {
  const row = await database
    .prepare(`SELECT ${adminExistsSql('?1', '?2')} AS ok`)
    .bind(identityId, now)
    .first<{ ok: number }>()
  if (!row?.ok) throw new SecurityControlError('forbidden', 403)
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE|PRIMARY KEY|constraint failed/i.test(error.message)
}

export interface CommandRow {
  command_id: string
  kind: string
  payload_hash: string
  key_id?: string
  result_key_id?: string | null
  device_id?: string
}

export function parseJson<T>(text: string): T {
  return JSON.parse(text) as T
}

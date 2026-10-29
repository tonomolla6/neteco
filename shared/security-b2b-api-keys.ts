import { z } from 'zod'

/** SEC-038: scopes a B2B API key may carry. Least privilege: every key lists the scopes it needs. */
export const API_KEY_SCOPES = [
  'catalog:read',
  'prices:read',
  'stock:read',
  'orders:read',
  'orders:write',
  'invoices:read',
  'edi:orders'
] as const
export const apiKeyScopeSchema = z.enum(API_KEY_SCOPES)
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>

export const API_KEY_PREFIX_LENGTH = 12
export const API_KEY_MAX_ACTIVE_PER_COMPANY = 20
export const API_KEY_MAX_LIFETIME_DAYS = 365
export const API_KEY_MAX_GRACE_SECONDS = 7 * 86_400

const KEY_PATTERN = /^(ntk_[0-9a-f]{8})_([A-Za-z0-9_-]{43})$/

/** Split a presented key into its public prefix and secret; null when the format is not ours. */
export function parseApiKey(presented: string): { prefix: string; secret: string } | null {
  if (typeof presented !== 'string' || presented.length > 80) return null
  const match = KEY_PATTERN.exec(presented)
  return match ? { prefix: match[1]!, secret: match[2]! } : null
}

function parseIpv4(value: string): number | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  let result = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    result = result * 256 + octet
  }
  return result
}

function normalizeIpv6(value: string): string | null {
  if (value.length > 45 || !/^[0-9a-fA-F:]+$/.test(value) || value.split(':').length < 3) return null
  try {
    return new URL(`http://[${value}]`).hostname
  } catch {
    return null
  }
}

type ParsedIp = { kind: 4; value: number } | { kind: 6; value: string }

function parseIp(value: string): ParsedIp | null {
  const v4 = parseIpv4(value)
  if (v4 !== null) return { kind: 4, value: v4 }
  const v6 = normalizeIpv6(value)
  return v6 ? { kind: 6, value: v6 } : null
}

/** Allow-list entries: IPv4, IPv4 CIDR /8../32, or IPv6 exact. Nothing broader than a /8. */
export function isValidAllowlistEntry(entry: string): boolean {
  if (typeof entry !== 'string') return false
  const slash = entry.indexOf('/')
  if (slash < 0) return parseIp(entry) !== null
  const base = parseIpv4(entry.slice(0, slash))
  const bits = entry.slice(slash + 1)
  if (base === null || !/^\d{1,2}$/.test(bits)) return false
  const length = Number(bits)
  return length >= 8 && length <= 32
}

export function ipMatchesAllowlist(ip: string | null, entries: readonly string[]): boolean {
  if (!ip) return false
  const candidate = parseIp(ip)
  if (!candidate) return false
  for (const entry of entries) {
    const slash = entry.indexOf('/')
    if (slash >= 0) {
      if (candidate.kind !== 4) continue
      const base = parseIpv4(entry.slice(0, slash))
      const length = Number(entry.slice(slash + 1))
      if (base === null || !Number.isInteger(length)) continue
      const size = 2 ** (32 - length)
      if (Math.floor(candidate.value / size) === Math.floor(base / size)) return true
      continue
    }
    const parsed = parseIp(entry)
    if (parsed && parsed.kind === candidate.kind && parsed.value === candidate.value) return true
  }
  return false
}

const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
const scopesSchema = z
  .array(apiKeyScopeSchema)
  .min(1)
  .max(10)
  .refine((scopes) => new Set(scopes).size === scopes.length, 'duplicate_scopes')
const allowedIpsSchema = z.array(z.string().refine(isValidAllowlistEntry, 'invalid_ip_entry')).min(1).max(20)
const commandId = z.string().uuid()
const keyId = z.string().uuid()

export const createApiKeyInputSchema = z
  .object({
    commandId,
    companyId: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    scopes: scopesSchema,
    expiresAt: timestamp,
    allowedIps: allowedIpsSchema.optional(),
    quotaPerMinute: z.number().int().min(1).max(6000).default(60),
    quotaPerDay: z.number().int().min(1).max(1_000_000).default(10_000)
  })
  .strict()
export type CreateApiKeyInput = z.infer<typeof createApiKeyInputSchema>

export const rotateApiKeyInputSchema = z
  .object({
    commandId,
    keyId,
    expectedVersion: z.number().int().min(1),
    graceSeconds: z.number().int().min(0).max(API_KEY_MAX_GRACE_SECONDS),
    newExpiresAt: timestamp.optional()
  })
  .strict()
export type RotateApiKeyInput = z.infer<typeof rotateApiKeyInputSchema>

export const revokeApiKeyInputSchema = z
  .object({ commandId, keyId, reason: z.string().trim().min(1).max(200) })
  .strict()
export type RevokeApiKeyInput = z.infer<typeof revokeApiKeyInputSchema>

export const updateApiKeyPolicyInputSchema = z
  .object({
    commandId,
    keyId,
    expectedVersion: z.number().int().min(1),
    scopes: scopesSchema.optional(),
    allowedIps: allowedIpsSchema.nullable().optional(),
    quotaPerMinute: z.number().int().min(1).max(6000).optional(),
    quotaPerDay: z.number().int().min(1).max(1_000_000).optional()
  })
  .strict()
  .refine(
    (value) =>
      value.scopes !== undefined ||
      value.allowedIps !== undefined ||
      value.quotaPerMinute !== undefined ||
      value.quotaPerDay !== undefined,
    'empty_policy_update'
  )
export type UpdateApiKeyPolicyInput = z.infer<typeof updateApiKeyPolicyInputSchema>

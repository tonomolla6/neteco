import { z } from 'zod'

export const DEVICE_KINDS = ['warehouse_scanner', 'warehouse_tablet', 'delivery_phone'] as const
export const DEVICE_PLATFORMS = ['android', 'ios', 'rugged_os'] as const
export const DEVICE_STATUSES = [
  'pending_enrollment',
  'active',
  'locked',
  'lost',
  'wipe_pending',
  'wiped',
  'retired'
] as const
export type DeviceStatus = (typeof DEVICE_STATUSES)[number]

export const MIN_PASSCODE_LENGTH = 6
/** Posture older than this is treated as unknown: the device must check in again. */
export const POSTURE_MAX_AGE_SECONDS = 72 * 3600
export const OFFLINE_MAX_TTL_SECONDS = 24 * 3600

/** Mailbox-style names that denote a shared account instead of a person. */
const SHARED_LOCAL_PARTS = new Set([
  'almacen',
  'almacén',
  'reparto',
  'warehouse',
  'delivery',
  'shared',
  'compartido',
  'info',
  'admin',
  'soporte',
  'support',
  'logistica',
  'logística',
  'pedidos',
  'operaciones',
  'test'
])

export function isSharedAccountEmail(email: string): boolean {
  const local = email.split('@')[0]?.trim().toLowerCase() ?? ''
  return SHARED_LOCAL_PARTS.has(local)
}

export const devicePostureSchema = z
  .object({
    diskEncrypted: z.boolean(),
    screenLockEnabled: z.boolean(),
    passcodeLength: z.number().int().min(0).max(64),
    jailbroken: z.boolean()
  })
  .strict()
export type DevicePosture = z.infer<typeof devicePostureSchema>

export type PostureViolation =
  'disk_not_encrypted' | 'screen_lock_disabled' | 'passcode_too_short' | 'device_compromised'

export function evaluatePosture(posture: DevicePosture): { compliant: boolean; violations: PostureViolation[] } {
  const violations: PostureViolation[] = []
  if (!posture.diskEncrypted) violations.push('disk_not_encrypted')
  if (!posture.screenLockEnabled) violations.push('screen_lock_disabled')
  if (posture.passcodeLength < MIN_PASSCODE_LENGTH) violations.push('passcode_too_short')
  if (posture.jailbroken) violations.push('device_compromised')
  return { compliant: violations.length === 0, violations }
}

const commandId = z.string().uuid()
const deviceId = z.string().uuid()
const expectedVersion = z.number().int().min(1)

export const enrollDeviceInputSchema = z
  .object({
    commandId,
    label: z.string().trim().min(1).max(80),
    kind: z.enum(DEVICE_KINDS),
    platform: z.enum(DEVICE_PLATFORMS),
    assignedIdentityId: z.string().uuid()
  })
  .strict()
export const deviceTransitionInputSchema = z
  .object({ commandId, deviceId, expectedVersion, reason: z.string().trim().min(1).max(200).optional() })
  .strict()
export const deviceWipeInputSchema = z
  .object({ commandId, deviceId, expectedVersion, reason: z.string().trim().min(1).max(200) })
  .strict()
export const deviceWipeConfirmSchema = z.object({ commandId, deviceId }).strict()

/**
 * Offline data minimisation: only operational identifiers. No names, addresses, phones, emails or
 * free text. Identifiers must look like codes and never like contact data.
 */
const code = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/)
  .refine((value) => /[A-Za-z]/.test(value) || value.replace(/[._-]/g, '').length < 9, 'looks_like_phone_number')

export const offlineManifestSchema = z
  .object({
    shiftId: code,
    stops: z
      .array(
        z
          .object({
            stopId: code,
            orderNumber: code,
            lines: z
              .array(z.object({ sku: code, quantity: z.number().int().min(1).max(9999) }).strict())
              .min(1)
              .max(50)
          })
          .strict()
      )
      .min(1)
      .max(200),
    expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .strict()
export type OfflineManifest = z.infer<typeof offlineManifestSchema>

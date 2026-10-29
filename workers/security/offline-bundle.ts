import { z } from 'zod'
import {
  OFFLINE_MAX_TTL_SECONDS,
  offlineManifestSchema,
  type OfflineManifest
} from '../../shared/security-warehouse-devices'
import {
  SecurityControlError,
  assertSecret,
  fromBase64Url,
  parseInput,
  plusSeconds,
  toBase64Url
} from './controls-common'
import { authorizeDeviceAccess } from './warehouse-devices'

export interface OfflineEnvelope {
  v: 1
  deviceId: string
  keyVersion: number
  iv: string
  ct: string
  expiresAt: string
}

const encoder = new TextEncoder()

/** Per-device, per-key-version AES-256-GCM key derived with HKDF; nothing is stored, rotating the version revokes old bundles. */
async function deriveKey(masterKey: string, deviceId: string, keyVersion: number, usage: 'encrypt' | 'decrypt') {
  const base = await crypto.subtle.importKey('raw', encoder.encode(masterKey), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(deviceId),
      info: encoder.encode(`neteco-offline-v${keyVersion}`)
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  )
}

const aad = (deviceId: string, keyVersion: number, expiresAt: string) =>
  encoder.encode(`${deviceId}|${keyVersion}|${expiresAt}`)

export async function sealOfflineBundle(
  database: D1Database,
  rawInput: { deviceId: string; manifest: unknown },
  context: { actorIdentityId: string; now: string; masterKey: string }
): Promise<OfflineEnvelope> {
  assertSecret(context.masterKey)
  const deviceId = parseInput(z.string().uuid(), rawInput.deviceId)
  const manifest: OfflineManifest = parseInput(offlineManifestSchema, rawInput.manifest)
  if (manifest.expiresAt <= context.now || manifest.expiresAt > plusSeconds(context.now, OFFLINE_MAX_TTL_SECONDS)) {
    throw new SecurityControlError('invalid_input', 400)
  }
  const access = await authorizeDeviceAccess(
    database,
    { deviceId, identityId: context.actorIdentityId },
    { now: context.now }
  )
  if (!access.ok) {
    const status =
      access.code === 'device_not_found'
        ? 404
        : ['device_not_assigned', 'identity_not_active'].includes(access.code)
          ? 403
          : 409
    throw new SecurityControlError(access.code, status)
  }
  const keyVersion = access.device.offlineKeyVersion
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(context.masterKey, deviceId, keyVersion, 'encrypt')
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(deviceId, keyVersion, manifest.expiresAt) },
      key,
      encoder.encode(JSON.stringify(manifest))
    )
  )
  return { v: 1, deviceId, keyVersion, iv: toBase64Url(iv), ct: toBase64Url(ciphertext), expiresAt: manifest.expiresAt }
}

/** Reference decryptor (also what a server-side verification or a test harness uses). */
export async function openOfflineBundle(
  envelope: OfflineEnvelope,
  context: { keyVersion: number; masterKey: string; now: string }
): Promise<OfflineManifest> {
  assertSecret(context.masterKey)
  if (envelope.expiresAt <= context.now) throw new SecurityControlError('bundle_expired', 410)
  if (envelope.v !== 1 || envelope.keyVersion !== context.keyVersion)
    throw new SecurityControlError('bundle_invalid', 400)
  try {
    const key = await deriveKey(context.masterKey, envelope.deviceId, envelope.keyVersion, 'decrypt')
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(envelope.iv),
        additionalData: aad(envelope.deviceId, envelope.keyVersion, envelope.expiresAt)
      },
      key,
      fromBase64Url(envelope.ct)
    )
    return offlineManifestSchema.parse(JSON.parse(new TextDecoder().decode(plain)))
  } catch {
    throw new SecurityControlError('bundle_invalid', 400)
  }
}

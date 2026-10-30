import { z } from 'zod'

export const ugcPhotoMimeTypes = ['image/jpeg', 'image/png', 'image/webp'] as const
export type UgcPhotoMimeType = (typeof ugcPhotoMimeTypes)[number]

export const ugcReviewPhotoInputSchema = z
  .object({
    storageKey: z.string().trim().min(5).max(200),
    photoUrl: z.string().trim().url().max(500),
    mimeType: z.enum(ugcPhotoMimeTypes),
    fileSizeBytes: z.number().int().positive().max(10485760), // max 10MB
    sha256: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/i),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    base64Data: z.string().optional()
  })
  .strict()

export const incentiveTypes = ['none', 'free_sample', 'discount_coupon', 'monetary_reward', 'loyalty_points'] as const
export type IncentiveType = (typeof incentiveTypes)[number]

export const submitUgcReviewSchema = z
  .object({
    productId: z.string().trim().min(1).max(64),
    orderId: z.string().trim().min(1).max(64).optional(),
    rating: z.number().int().min(1).max(5),
    title: z.string().trim().min(3).max(160),
    content: z.string().trim().min(10).max(3000),
    displayName: z.string().trim().min(1).max(100),
    consentAccepted: z.literal(true),
    consentVersion: z.string().trim().min(1).max(32).default('2026-ugc-v1'),
    licenseTerms: z.literal('royalty_free_commercial_display'),
    rightsConfirmed: z.literal(true),
    hasIncentive: z.boolean().default(false),
    incentiveType: z.enum(incentiveTypes).default('none'),
    incentiveDescription: z.string().trim().max(500).optional(),
    photos: z.array(ugcReviewPhotoInputSchema).max(5).default([]),
    commandId: z.string().trim().min(1).max(64)
  })
  .strict()
  .refine(
    (data) => {
      if (data.hasIncentive) {
        return (
          data.incentiveType !== 'none' &&
          typeof data.incentiveDescription === 'string' &&
          data.incentiveDescription.length >= 3
        )
      }
      return data.incentiveType === 'none'
    },
    {
      message:
        'Si la reseña cuenta con compensación o muestra, debe especificarse el tipo e informe descriptivo claro (no incentivos ocultos)',
      path: ['incentiveDescription']
    }
  )

export type SubmitUgcReviewInput = z.infer<typeof submitUgcReviewSchema>

export const moderateUgcPhotoItemSchema = z
  .object({
    photoId: z.string().trim().min(1).max(64),
    action: z.enum(['approve', 'reject', 'quarantine']),
    reason: z.string().trim().max(500).optional()
  })
  .strict()

export const moderateUgcReviewSchema = z
  .object({
    reviewId: z.string().trim().min(1).max(64),
    action: z.enum(['approve', 'reject', 'quarantine']),
    reason: z.string().trim().min(3).max(500),
    expectedVersion: z.number().int().nonnegative(),
    photoModerations: z.array(moderateUgcPhotoItemSchema).optional(),
    commandId: z.string().trim().min(1).max(64)
  })
  .strict()

export type ModerateUgcReviewInput = z.infer<typeof moderateUgcReviewSchema>

export const withdrawUgcReviewSchema = z
  .object({
    reviewId: z.string().trim().min(1).max(64),
    reason: z.enum(['customer_revocation', 'copyright_claim', 'admin_takedown', 'gdpr_erasure']),
    notes: z.string().trim().max(500).optional(),
    expectedVersion: z.number().int().nonnegative(),
    commandId: z.string().trim().min(1).max(64)
  })
  .strict()

export type WithdrawUgcReviewInput = z.infer<typeof withdrawUgcReviewSchema>

export interface AntivirusScanResult {
  status: 'clean' | 'infected' | 'quarantined'
  signature: string | null
  scanner: string
  scannedAt: string
}

export function scanPhotoAntivirus(params: {
  bytes: Uint8Array
  mimeType: UgcPhotoMimeType
  sha256: string
  now?: string
}): AntivirusScanResult {
  const { bytes, mimeType, now = new Date().toISOString() } = params
  const scannerName = 'neteco-antivirus-gateway-v1'

  // 1. Scan for EICAR test string or malware signature FIRST
  const textContent = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (textContent.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) {
    return {
      status: 'infected',
      signature: 'EICAR_STANDARD_TEST_FILE_DETECTED',
      scanner: scannerName,
      scannedAt: now
    }
  }

  // 2. Magic bytes validation
  let magicValid = false
  if (mimeType === 'image/png' && bytes.length >= 8) {
    magicValid =
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
  } else if (mimeType === 'image/jpeg' && bytes.length >= 3) {
    magicValid = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  } else if (mimeType === 'image/webp' && bytes.length >= 12) {
    // RIFF....WEBP
    magicValid =
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
  }

  if (!magicValid) {
    return {
      status: 'quarantined',
      signature: 'CORRUPTED_MAGIC_HEADER',
      scanner: scannerName,
      scannedAt: now
    }
  }

  return {
    status: 'clean',
    signature: null,
    scanner: scannerName,
    scannedAt: now
  }
}

export interface PiiMatch {
  type: 'phone' | 'email' | 'national_id' | 'credit_card'
  match: string
}

export interface PiiScanResult {
  piiDetected: boolean
  piiMatches: PiiMatch[]
  redactedText: string
}

const EMAIL_REGEX = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g
const PHONE_REGEX = /(?:\+34\s*)?(?:[6789]\d{2}[\s.-]?\d{3}[\s.-]?\d{3}|[6789]\d{8})/g
const DNI_NIE_REGEX = /\b(?:\d{8}[A-HJ-NP-TV-Z]|[XYZ]\d{7}[A-HJ-NP-TV-Z])\b/gi
const CREDIT_CARD_REGEX = /\b(?:\d{4}[ -]?){3}\d{4}\b/g

export function scanTextForPii(text: string): PiiScanResult {
  const piiMatches: PiiMatch[] = []

  // Emails
  const emails = text.match(EMAIL_REGEX)
  if (emails) {
    for (const match of emails) {
      piiMatches.push({ type: 'email', match })
    }
  }

  // Phones
  const phones = text.match(PHONE_REGEX)
  if (phones) {
    for (const match of phones) {
      piiMatches.push({ type: 'phone', match })
    }
  }

  // DNI/NIE
  const dnis = text.match(DNI_NIE_REGEX)
  if (dnis) {
    for (const match of dnis) {
      piiMatches.push({ type: 'national_id', match })
    }
  }

  // Credit Cards
  const cards = text.match(CREDIT_CARD_REGEX)
  if (cards) {
    for (const match of cards) {
      piiMatches.push({ type: 'credit_card', match })
    }
  }

  const redactedText = redactPiiFromText(text)

  return {
    piiDetected: piiMatches.length > 0,
    piiMatches,
    redactedText
  }
}

export function redactPiiFromText(text: string): string {
  return text
    .replace(EMAIL_REGEX, '[EMAIL REDACTADO]')
    .replace(PHONE_REGEX, '[TELÉFONO REDACTADO]')
    .replace(DNI_NIE_REGEX, '[DOCUMENTO REDACTADO]')
    .replace(CREDIT_CARD_REGEX, '[TARJETA REDACTADA]')
}

const SUSPICIOUS_INCENTIVE_TERMS = [
  'a cambio de',
  'me regalaron',
  'producto gratis',
  'sorteo',
  'cupon regalo',
  'cupón regalo',
  'descuento por poner',
  'descuento por reseña',
  'muestra gratis',
  'me pagaron'
]

export interface HiddenIncentiveCheck {
  hiddenIncentiveSuspected: boolean
  reasons: string[]
}

export function detectHiddenIncentives(text: string, declaredIncentiveType: string): HiddenIncentiveCheck {
  const reasons: string[] = []
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')

  if (declaredIncentiveType === 'none') {
    for (const term of SUSPICIOUS_INCENTIVE_TERMS) {
      const termNorm = term.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      if (normalized.includes(termNorm)) {
        reasons.push(`Contiene referencia no declarada a compensación o regalo: "${term}"`)
      }
    }
  }

  return {
    hiddenIncentiveSuspected: reasons.length > 0,
    reasons
  }
}

export async function evaluateUgcReviewPayloadHash(data: unknown): Promise<string> {
  const serialized = JSON.stringify(data, Object.keys(data as object).sort())
  const encoder = new TextEncoder()
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(serialized))
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface PublicUgcPhoto {
  id: string
  photoUrl: string
  mimeType: UgcPhotoMimeType
  width: number
  height: number
  sortOrder: number
}

export interface PublicUgcReview {
  id: string
  productId: string
  rating: number
  title: string
  content: string
  displayName: string
  isVerifiedBuyer: boolean
  photos: PublicUgcPhoto[]
  incentiveBadge: string
  incentiveDisclosure: string | null
  createdAt: string
}

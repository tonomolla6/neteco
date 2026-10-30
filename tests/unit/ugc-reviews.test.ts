import { describe, expect, it } from 'vitest'
import {
  detectHiddenIncentives,
  redactPiiFromText,
  scanPhotoAntivirus,
  scanTextForPii,
  submitUgcReviewSchema,
  moderateUgcReviewSchema,
  withdrawUgcReviewSchema
} from '../../shared/ugc-reviews'

// 1x1 valid PNG and JPEG fixtures in base64
const VALID_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const VALID_JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString(
  'base64'
)
const EICAR_TEST_STRING = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
const INFECTED_FILE_BASE64 = Buffer.from(EICAR_TEST_STRING).toString('base64')

describe('MED-018: UGC / Customer Reviews with Photos & Moderation', () => {
  describe('Zod Schema Validation & Consent / Licensing', () => {
    it('accepts a complete, valid review submission with consent, license and no incentive', () => {
      const input = {
        productId: 'prod-limpiador-alcalino-5l',
        orderId: 'ord-2026-001',
        rating: 5,
        title: 'Excelente resultado en taller',
        content:
          'Desengrasa de maravilla las piezas mecánicas sin dañar las juntas de goma. Muy satisfecho con la compra.',
        displayName: 'Taller Mecánico Hermanos M.',
        consentAccepted: true,
        consentVersion: '2026-ugc-v1',
        licenseTerms: 'royalty_free_commercial_display',
        rightsConfirmed: true,
        hasIncentive: false,
        incentiveType: 'none',
        photos: [
          {
            storageKey: 'ugc/reviews/r1/photo1.png',
            photoUrl: 'https://media.neteco.es/ugc/reviews/r1/photo1.png',
            mimeType: 'image/png',
            fileSizeBytes: 2048,
            sha256: 'a'.repeat(64),
            width: 800,
            height: 600
          }
        ],
        commandId: 'cmd-ugc-001'
      }

      const parsed = submitUgcReviewSchema.safeParse(input)
      expect(parsed.success).toBe(true)
    })

    it('rejects submission if user refuses consent or rights confirmation', () => {
      const inputWithoutConsent = {
        productId: 'prod-1',
        rating: 4,
        title: 'Buen producto',
        content: 'Funciona bien para la limpieza diaria de suelos.',
        displayName: 'Carlos',
        consentAccepted: false, // Refused consent
        licenseTerms: 'royalty_free_commercial_display',
        rightsConfirmed: true,
        hasIncentive: false,
        commandId: 'cmd-1'
      }

      const res1 = submitUgcReviewSchema.safeParse(inputWithoutConsent)
      expect(res1.success).toBe(false)

      const inputWithoutRights = {
        ...inputWithoutConsent,
        consentAccepted: true,
        rightsConfirmed: false // Refused rights confirmation
      }
      const res2 = submitUgcReviewSchema.safeParse(inputWithoutRights)
      expect(res2.success).toBe(false)
    })

    it('rejects invalid ratings outside 1-5', () => {
      const invalidRating = {
        productId: 'prod-1',
        rating: 6,
        title: 'Super bueno',
        content: 'Contenido suficientemente largo para pasar longitud mínima.',
        displayName: 'Carlos',
        consentAccepted: true,
        licenseTerms: 'royalty_free_commercial_display',
        rightsConfirmed: true,
        hasIncentive: false,
        commandId: 'cmd-1'
      }
      expect(submitUgcReviewSchema.safeParse(invalidRating).success).toBe(false)
    })

    it('rejects more than 5 photos per review', () => {
      const photos = Array.from({ length: 6 }).map((_, i) => ({
        storageKey: `ugc/p${i}.png`,
        photoUrl: `https://media.neteco.es/ugc/p${i}.png`,
        mimeType: 'image/png' as const,
        fileSizeBytes: 1024,
        sha256: 'a'.repeat(64),
        width: 600,
        height: 600
      }))

      const input = {
        productId: 'prod-1',
        rating: 5,
        title: 'Muchas fotos',
        content: 'Excelente producto para desinfección industrial garantizada.',
        displayName: 'Carlos',
        consentAccepted: true,
        licenseTerms: 'royalty_free_commercial_display',
        rightsConfirmed: true,
        hasIncentive: false,
        photos,
        commandId: 'cmd-1'
      }
      expect(submitUgcReviewSchema.safeParse(input).success).toBe(false)
    })
  })

  describe('Antivirus Scanner Adapter', () => {
    it('approves clean PNG image bytes', () => {
      const buffer = Buffer.from(VALID_PNG_BASE64, 'base64')
      const result = scanPhotoAntivirus({
        bytes: buffer,
        mimeType: 'image/png',
        sha256: '1'.repeat(64)
      })

      expect(result.status).toBe('clean')
      expect(result.signature).toBeNull()
      expect(result.scanner).toContain('antivirus')
      expect(result.scannedAt).toBeDefined()
    })

    it('approves clean JPEG image bytes', () => {
      const buffer = Buffer.from(VALID_JPEG_BASE64, 'base64')
      const result = scanPhotoAntivirus({
        bytes: buffer,
        mimeType: 'image/jpeg',
        sha256: '2'.repeat(64)
      })

      expect(result.status).toBe('clean')
      expect(result.signature).toBeNull()
    })

    it('detects malware and flags file as infected with EICAR signature', () => {
      const buffer = Buffer.from(INFECTED_FILE_BASE64, 'base64')
      const result = scanPhotoAntivirus({
        bytes: buffer,
        mimeType: 'image/png',
        sha256: '3'.repeat(64)
      })

      expect(result.status).toBe('infected')
      expect(result.signature).toContain('EICAR_STANDARD_TEST_FILE')
    })

    it('flags corrupted files with invalid magic numbers as quarantined', () => {
      const corruptedBytes = Buffer.from('NOT_AN_IMAGE_HEADER_12345')
      const result = scanPhotoAntivirus({
        bytes: corruptedBytes,
        mimeType: 'image/png',
        sha256: '4'.repeat(64)
      })

      expect(result.status).toBe('quarantined')
      expect(result.signature).toBe('CORRUPTED_MAGIC_HEADER')
    })
  })

  describe('PII Scanner & Redaction', () => {
    it('detects phone numbers, emails, and DNI in review content', () => {
      const text =
        'Llamadme al 612345678 o al +34 912 345 678, o escribid a contacto@tallerperez.es. Mi DNI es 12345678Z.'
      const scan = scanTextForPii(text)

      expect(scan.piiDetected).toBe(true)
      expect(scan.piiMatches.length).toBeGreaterThanOrEqual(3)
      const types = scan.piiMatches.map((m) => m.type)
      expect(types).toContain('phone')
      expect(types).toContain('email')
      expect(types).toContain('national_id')
    })

    it('redacts detected PII cleanly replacing with placeholders', () => {
      const text = 'Mi teléfono es 654987321 y mi correo es juan@example.com.'
      const redacted = redactPiiFromText(text)

      expect(redacted).not.toContain('654987321')
      expect(redacted).not.toContain('juan@example.com')
      expect(redacted).toContain('[TELÉFONO REDACTADO]')
      expect(redacted).toContain('[EMAIL REDACTADO]')
    })

    it('returns clean result when no PII is present in technical product review', () => {
      const cleanText =
        'Excelente desengrasante alcalino. Quita grasa pesada en 5 minutos diluido al 10% en agua tibia.'
      const scan = scanTextForPii(cleanText)

      expect(scan.piiDetected).toBe(false)
      expect(scan.piiMatches).toHaveLength(0)
      expect(scan.redactedText).toBe(cleanText)
    })
  })

  describe('Incentive Transparency ("No incentivos ocultos")', () => {
    it('validates explicit incentive declaration when a sample was provided', () => {
      const incentivized = {
        productId: 'prod-1',
        rating: 5,
        title: 'Muestra recibida en feria',
        content: 'Probamos la muestra de 1 litro que nos entregó el comercial en la feria hostelera.',
        displayName: 'Restaurante El Puerto',
        consentAccepted: true,
        licenseTerms: 'royalty_free_commercial_display',
        rightsConfirmed: true,
        hasIncentive: true,
        incentiveType: 'free_sample' as const,
        incentiveDescription: 'Muestra comercial gratuita de 1L entregada en feria HOSTELCO',
        commandId: 'cmd-inc-1'
      }

      const parsed = submitUgcReviewSchema.safeParse(incentivized)
      expect(parsed.success).toBe(true)
    })

    it('rejects hasIncentive: true if incentiveDescription is missing', () => {
      const missingDesc = {
        productId: 'prod-1',
        rating: 5,
        title: 'Muestra recibida',
        content: 'Probamos el limpiador con excelentes resultados en campanas extractoras.',
        displayName: 'Restaurante',
        consentAccepted: true,
        licenseTerms: 'royalty_free_commercial_display',
        rightsConfirmed: true,
        hasIncentive: true,
        incentiveType: 'free_sample' as const,
        incentiveDescription: '', // empty
        commandId: 'cmd-inc-2'
      }

      expect(submitUgcReviewSchema.safeParse(missingDesc).success).toBe(false)
    })

    it('detects hidden incentive when user claims no incentive but text contains giveaway phrases', () => {
      const suspiciousText = 'Me dieron este producto gratis a cambio de poner 5 estrellas en una reseña.'
      const check = detectHiddenIncentives(suspiciousText, 'none')

      expect(check.hiddenIncentiveSuspected).toBe(true)
      expect(check.reasons.length).toBeGreaterThan(0)
    })

    it('does not flag genuine organic review as suspicious', () => {
      const organicText = 'Lo compramos con nuestra factura habitual de material de limpieza de oficinas.'
      const check = detectHiddenIncentives(organicText, 'none')

      expect(check.hiddenIncentiveSuspected).toBe(false)
      expect(check.reasons).toHaveLength(0)
    })
  })

  describe('Withdrawal / Retirada & Moderation Schemas', () => {
    it('validates withdrawal request with valid reason', () => {
      const withdrawal = {
        reviewId: 'rev-100',
        reason: 'customer_revocation',
        notes: 'Cliente ejerce derecho de revocación de consentimiento de imagen.',
        expectedVersion: 1,
        commandId: 'cmd-with-1'
      }

      const parsed = withdrawUgcReviewSchema.safeParse(withdrawal)
      expect(parsed.success).toBe(true)
    })

    it('validates moderation approval or quarantine schema', () => {
      const moderation = {
        reviewId: 'rev-100',
        action: 'approve',
        reason: 'Revisión técnica de fotos y texto aprobada por moderación',
        expectedVersion: 1,
        photoModerations: [
          {
            photoId: 'photo-1',
            action: 'approve',
            reason: 'Foto limpia de etiquetas PII y virus'
          }
        ],
        commandId: 'cmd-mod-1'
      }

      const parsed = moderateUgcReviewSchema.safeParse(moderation)
      expect(parsed.success).toBe(true)
    })
  })
})

import { describe, expect, it } from 'vitest'
import {
  buildMediaPublicationPayload,
  mediaPublicationError,
  publicationLocalTime,
  publicationRoles
} from '../../app/utils/mediaPublication'
import type { PublicationFormInput } from '../../app/utils/mediaPublication'

const input = (): PublicationFormInput => ({
  productId: '10000000-0000-4000-8000-000000000001',
  variantId: '20000000-0000-4000-8000-000000000001',
  mimeType: 'image/jpeg',
  role: 'main',
  title: ' Producto ',
  altText: ' Envase con etiqueta visible ',
  language: 'es',
  version: '1',
  validFromLocal: '2026-09-30T10:00:00',
  validUntilLocal: ''
})

describe('publication form contract', () => {
  it('whitelists identifiers and metadata, converting local time to canonical UTC', () => {
    const result = buildMediaPublicationPayload({
      ...input(),
      objectKey: 'quarantine/private',
      sourceUrl: 'https://private.invalid',
      scanVerdict: 'clean'
    } as PublicationFormInput)
    expect(result).toEqual({
      productId: input().productId,
      variantId: input().variantId,
      role: 'main',
      title: 'Producto',
      altText: 'Envase con etiqueta visible',
      language: 'es',
      version: '1',
      validFrom: new Date(input().validFromLocal).toISOString().replace('.000Z', 'Z'),
      validUntil: null
    })
  })

  it('permits product-level association without inventing a SKU', () => {
    expect(buildMediaPublicationPayload({ ...input(), variantId: null })?.variantId).toBeNull()
  })

  it.each(['https://private.invalid/object', 'legacy:11', '11', ''])('rejects a non-UUID identifier: %s', (id) => {
    expect(buildMediaPublicationPayload({ ...input(), productId: id })).toBeNull()
    expect(buildMediaPublicationPayload({ ...input(), variantId: id })).toBeNull()
  })

  it.each(['2026-02-30T10:00', '2026-13-01T10:00', '2026-09-30T24:01', '2026-09-30T10:00:00Z'])(
    'rejects invalid local dates: %s',
    (date) => {
      expect(buildMediaPublicationPayload({ ...input(), validFromLocal: date })).toBeNull()
    }
  )

  it('uses an exclusive expiry after the start and supports minute precision input', () => {
    expect(buildMediaPublicationPayload({ ...input(), validUntilLocal: input().validFromLocal })).toBeNull()
    expect(buildMediaPublicationPayload({ ...input(), validUntilLocal: '2026-09-30T09:00' })).toBeNull()
    expect(
      buildMediaPublicationPayload({
        ...input(),
        validFromLocal: '2026-09-30T10:00',
        validUntilLocal: '2026-10-01T10:00'
      })?.validUntil
    ).toMatch(/T.*:00Z$/)
  })

  it('restricts roles to the real MIME type without fake image/PDF conversions', () => {
    expect(publicationRoles('image/png').map((role) => role.value)).toEqual(['main', 'image', 'label'])
    expect(publicationRoles('application/pdf').map((role) => role.value)).toEqual([
      'datasheet',
      'sds',
      'certificate',
      'label'
    ])
    expect(publicationRoles('image/svg+xml')).toEqual([])
    expect(buildMediaPublicationPayload({ ...input(), role: 'sds' })).toBeNull()
    expect(buildMediaPublicationPayload({ ...input(), mimeType: 'application/pdf' })).toBeNull()
  })

  it.each([{ altText: 'x' }, { title: '' }, { language: 'es_ES' }, { version: '' }, { version: 'v\u0001' }])(
    'rejects invalid metadata: %j',
    (changes) => {
      expect(buildMediaPublicationPayload({ ...input(), ...changes })).toBeNull()
    }
  )

  it('reports closed error codes without exposing arbitrary messages or keys', () => {
    const privateMessage = 'https://private.invalid/quarantine/key'
    for (const cause of [
      null,
      { data: { message: privateMessage } },
      { data: { error: { code: privateMessage } } },
      { data: { error: { code: '__proto__' } } }
    ]) {
      expect(mediaPublicationError(cause)).not.toContain(privateMessage)
      expect(mediaPublicationError(cause)).toContain('reintentar')
    }
    expect(mediaPublicationError({ data: { error: { code: 'forbidden' } } })).toContain('permiso')
  })

  it('formats local time without a timezone suffix or milliseconds', () => {
    expect(publicationLocalTime(new Date(2026, 8, 30, 9, 4, 2))).toBe('2026-09-30T09:04:02')
  })
})

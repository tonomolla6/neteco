import { describe, expect, it } from 'vitest'
import {
  detectMediaType,
  imageDimensions,
  safeMediaFilename,
  stripMediaMetadata,
  validateMediaUploadEnvelope
} from '../../server/utils/media-upload'

function pngChunk(type: string, data = Buffer.alloc(0)) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)])
}

function png(width = 800, height = 600) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('tEXt', Buffer.from('private metadata')),
    pngChunk('IDAT'),
    pngChunk('IEND')
  ])
}

function jpeg() {
  const applicationMetadata = Buffer.from([0xff, 0xe1, 0x00, 0x06, 1, 2, 3, 4])
  const frame = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 8, 0x02, 0x58, 0x03, 0x20, 1, 1, 0, 0])
  const scan = Buffer.from([0xff, 0xda, 1, 2, 3, 0xff, 0xd9])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), applicationMetadata, frame, scan])
}

describe('secure media normalization', () => {
  it('detects only allowlisted magic bytes', () => {
    expect(detectMediaType(png())).toBe('image/png')
    expect(detectMediaType(jpeg())).toBe('image/jpeg')
    expect(detectMediaType(Buffer.from('%PDF-1.7'))).toBe('application/pdf')
    expect(() => detectMediaType(Buffer.from('GIF89a'))).toThrow('no es JPEG, PNG o PDF')
  })

  it('normalizes dangerous names to a server-selected extension', () => {
    expect(safeMediaFilename('../../Ásset final.exe', 'image/jpeg', 'uuid')).toBe('uuid-asset-final-exe.jpg')
    expect(safeMediaFilename('...', 'application/pdf', 'uuid')).toBe('uuid-asset.pdf')
  })

  it('reads raster dimensions and strips common metadata chunks', () => {
    const originalPng = png()
    expect(imageDimensions(originalPng, 'image/png')).toEqual({ width: 800, height: 600 })
    expect(stripMediaMetadata(originalPng, 'image/png').includes(Buffer.from('private metadata'))).toBe(false)

    const originalJpeg = jpeg()
    expect(imageDimensions(originalJpeg, 'image/jpeg')).toEqual({ width: 800, height: 600 })
    expect(stripMediaMetadata(originalJpeg, 'image/jpeg').includes(Buffer.from([0xff, 0xe1]))).toBe(false)
    expect(imageDimensions(Buffer.from('%PDF-1.7'), 'application/pdf')).toBeNull()
    expect(stripMediaMetadata(Buffer.from('%PDF-1.7'), 'application/pdf').toString()).toBe('%PDF-1.7')
  })

  it('rejects truncated raster inputs', () => {
    expect(() => imageDimensions(Buffer.from([0x89]), 'image/png')).toThrow('PNG incompleto')
    expect(() => imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg')).toThrow('JPEG sin dimensiones')
  })

  it('enforces upload size and declared MIME before storage', () => {
    const bytes = png()
    expect(validateMediaUploadEnvelope({ bytes, declaredType: 'image/png', maximumBytes: bytes.length })).toBe(
      'image/png'
    )
    expect(
      validateMediaUploadEnvelope({ bytes, declaredType: 'application/octet-stream', maximumBytes: bytes.length })
    ).toBe('image/png')
    expect(() =>
      validateMediaUploadEnvelope({ bytes, declaredType: 'image/jpeg', maximumBytes: bytes.length })
    ).toThrow('MIME')
    expect(() =>
      validateMediaUploadEnvelope({ bytes, declaredType: 'image/png', maximumBytes: bytes.length - 1 })
    ).toThrow('tamaño')
    expect(() => validateMediaUploadEnvelope({ bytes: Buffer.from('GIF89a'), maximumBytes: 100 })).toThrow(
      'no es JPEG, PNG o PDF'
    )
  })

  it('keeps hostile filenames inside a generated flat storage key', () => {
    for (const name of ['../../etc/passwd', '..\\..\\windows\\system.ini', '/absolute/.env', 'a/../b.pdf']) {
      const filename = safeMediaFilename(name, 'application/pdf', 'fixed-id')
      expect(filename).toMatch(/^fixed-id-[a-z0-9_-]+\.pdf$/)
      expect(filename).not.toContain('..')
      expect(filename).not.toContain('/')
      expect(filename).not.toContain('\\')
    }
  })
})

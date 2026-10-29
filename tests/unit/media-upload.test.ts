import { describe, expect, it } from 'vitest'
import * as envelope from '../../shared/media-envelope'
import { imageDimensions as sharedDimensions } from '../../shared/media-dimensions'
import { stripMediaMetadata as stripMetadataBytes } from '../../shared/media-metadata'
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
  it('normalizes owned byte arrays while retaining the legacy Buffer contract', () => {
    for (const [source, type] of [
      [png(), 'image/png'],
      [jpeg(), 'image/jpeg'],
      [Buffer.from('%PDF-1.7'), 'application/pdf']
    ] as const) {
      const container = new Uint8Array(source.length + 20).fill(0x77)
      container.set(source, 7)
      const input = container.subarray(7, 7 + source.length)
      const before = new Uint8Array(input)
      const output = stripMetadataBytes(input, type)
      const legacy = stripMediaMetadata(input, type)
      expect(Buffer.isBuffer(output)).toBe(false)
      expect(Buffer.isBuffer(legacy)).toBe(true)
      expect(output).toEqual(new Uint8Array(legacy))
      expect(input).toEqual(before)
      output.fill(0)
      expect(input).toEqual(before)
    }
  })

  it('rejects incomplete chunk envelopes rather than returning partial normalized files', () => {
    for (const source of [png().subarray(0, 8), png().subarray(0, -1), png().subarray(0, -12)]) {
      expect(() => stripMetadataBytes(source, 'image/png')).toThrow('PNG incompleto')
    }
    for (const source of [new Uint8Array([0xff, 0xd8, 0xff, 0xe1]), jpeg().subarray(0, 23)]) {
      expect(() => stripMetadataBytes(source, 'image/jpeg')).toThrow('JPEG incompleto')
    }
    expect(() => stripMetadataBytes(png(), 'image/jpeg')).toThrow('MIME')
  })

  it('removes every supported PNG metadata chunk and preserves the image chunks', () => {
    const base = png()
    const extra = ['tEXt', 'zTXt', 'iTXt', 'eXIf'].map((type) => pngChunk(type, Buffer.from('private')))
    const source = Buffer.concat([base.subarray(0, 33), ...extra, base.subarray(-24)])
    const output = stripMetadataBytes(source, 'image/png')
    expect(output).toEqual(new Uint8Array(Buffer.concat([base.subarray(0, 33), base.subarray(-24)])))
    expect(stripMetadataBytes(output, 'image/png')).toEqual(output)
  })

  it('shares runtime-neutral envelope validation with the legacy upload endpoint', () => {
    expect(detectMediaType).toBe(envelope.detectMediaType)
    expect(validateMediaUploadEnvelope).toBe(envelope.validateMediaUploadEnvelope)
    expect(safeMediaFilename).toBe(envelope.safeMediaFilename)
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
    expect(envelope.validateMediaUploadEnvelope({ bytes, maximumBytes: 8, declaredType: 'application/pdf' })).toBe(
      'application/pdf'
    )
  })

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

  it('reads dimensions from bounded Uint8Array views without Node buffers', () => {
    expect(imageDimensions).toBe(sharedDimensions)
    for (const [source, type] of [
      [png(), 'image/png'],
      [jpeg(), 'image/jpeg']
    ] as const) {
      const container = new Uint8Array(source.length + 16).fill(0xff)
      container.set(source, 7)
      expect(sharedDimensions(container.subarray(7, 7 + source.length), type)).toEqual({ width: 800, height: 600 })
      expect(() => sharedDimensions(container.subarray(7, 10), type)).toThrow()
    }
  })

  it('rejects fake PNG headers and zero dimensions', () => {
    const wrongChunk = png()
    wrongChunk[12] = 0x58
    expect(() => imageDimensions(wrongChunk, 'image/png')).toThrow('IHDR')
    const wrongLength = png()
    wrongLength.writeUInt32BE(12, 8)
    expect(() => imageDimensions(wrongLength, 'image/png')).toThrow('IHDR')
    expect(() => imageDimensions(png(0, 600), 'image/png')).toThrow('dimensiones')
    expect(() => imageDimensions(png(800, 0), 'image/png')).toThrow('dimensiones')
    expect(() => imageDimensions(png().subarray(0, 24), 'image/png')).toThrow('IHDR')
    expect(() => imageDimensions(png(), 'image/jpeg')).toThrow('MIME')
  })

  it('rejects JPEG frames that borrow dimensions from outside their segment', () => {
    const shortFrame = jpeg()
    shortFrame[13] = 2
    expect(() => imageDimensions(shortFrame, 'image/jpeg')).toThrow('dimensiones')
    const badComponents = jpeg()
    badComponents[19] = 2
    expect(() => imageDimensions(badComponents, 'image/jpeg')).toThrow('dimensiones')
    const zeroHeight = jpeg()
    zeroHeight[15] = 0
    zeroHeight[16] = 0
    expect(() => imageDimensions(zeroHeight, 'image/jpeg')).toThrow('dimensiones')
    expect(() => imageDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0]), 'image/jpeg')).toThrow('incompleto')
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

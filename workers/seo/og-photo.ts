import type { OgPhoto } from './og-card'

/** Máximos defensivos: la foto se decodifica dentro del Worker. */
export const OG_PHOTO_MAX_BYTES = 1_500_000
const MAX_DIMENSION = 6000

function readJpeg(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = bytes[offset + 1]!
    if (marker === 0xff) {
      offset++
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) {
      return {
        height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!
      }
    }
    if (length < 2) return null
    offset += 2 + length
  }
  return null
}

function readPng(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

/** Valida JPEG/PNG por firma y tamaño; devuelve null (sin foto) ante cualquier otro formato o dato dudoso. */
export function toOgPhoto(bytes: Uint8Array): OgPhoto | null {
  if (!bytes.length || bytes.length > OG_PHOTO_MAX_BYTES) return null
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  const size = isJpeg ? readJpeg(bytes) : isPng ? readPng(bytes) : null
  if (!size || !(size.width > 0 && size.height > 0) || size.width > MAX_DIMENSION || size.height > MAX_DIMENSION)
    return null
  return { dataUri: `data:${isJpeg ? 'image/jpeg' : 'image/png'};base64,${base64(bytes)}`, ...size }
}

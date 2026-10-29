import { detectMediaType, type AllowedMediaType } from './media-envelope'

// Header inspection only: decoding, malware analysis and publication approval
// are separate gates. DataView must respect sliced Uint8Array boundaries.
export function imageDimensions(bytes: Uint8Array, type: AllowedMediaType) {
  if (type === 'application/pdf') return null
  if (type === 'image/png' && bytes.length < 24) throw new Error('PNG incompleto')
  if (type === 'image/jpeg' && bytes.length < 4) throw new Error('JPEG incompleto')
  if (detectMediaType(bytes) !== type) throw new Error('El MIME declarado no coincide con el contenido')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const dimensions = (width: number, height: number) => {
    if (width === 0 || height === 0) throw new Error('Imagen sin dimensiones válidas')
    return { width, height }
  }
  if (type === 'image/png') {
    if (
      bytes.length < 33 ||
      view.getUint32(8) !== 13 ||
      bytes[12] !== 0x49 ||
      bytes[13] !== 0x48 ||
      bytes[14] !== 0x44 ||
      bytes[15] !== 0x52
    )
      throw new Error('PNG sin cabecera IHDR válida')
    return dimensions(view.getUint32(16), view.getUint32(20))
  }
  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error('JPEG inválido')
    while (bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) throw new Error('JPEG incompleto')
    const marker = bytes[offset++]!
    if (marker === 0xda || marker === 0xd9) break
    if (marker === 0x00 || marker === 0xd8) throw new Error('JPEG inválido')
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) throw new Error('JPEG incompleto')
    const length = view.getUint16(offset)
    if (length < 2 || offset + length > bytes.length) throw new Error('JPEG incompleto')
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) throw new Error('JPEG sin dimensiones válidas')
      const components = bytes[offset + 7]!
      if (components === 0 || length !== 8 + 3 * components) throw new Error('JPEG sin dimensiones válidas')
      return dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3))
    }
    offset += length
  }
  throw new Error('JPEG sin dimensiones válidas')
}

import { detectMediaType, type AllowedMediaType } from './media-envelope'

function concatenate(chunks: Uint8Array[]) {
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

/**
 * Removes common PNG metadata and JPEG APP1/APP13 before the first scan.
 * Not a decoder, malware scanner or comprehensive privacy scrubber: JPEG scan
 * data and PDFs are preserved. Publication requires separate security gates.
 * Always returns an owned Uint8Array, never an alias of the input.
 */
export function stripMediaMetadata(bytes: Uint8Array, type: AllowedMediaType): Uint8Array {
  if (detectMediaType(bytes) !== type) throw new Error('El MIME declarado no coincide con el contenido')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (type === 'image/jpeg') {
    const chunks = [bytes.subarray(0, 2)]
    let offset = 2
    while (offset + 2 <= bytes.length) {
      if (bytes[offset] !== 0xff) throw new Error('JPEG inválido durante la normalización')
      const marker = bytes[offset + 1]!
      if (marker === 0xda) {
        chunks.push(bytes.subarray(offset))
        return concatenate(chunks)
      }
      if (marker === 0xd9) {
        chunks.push(bytes.subarray(offset, offset + 2))
        return concatenate(chunks)
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        chunks.push(bytes.subarray(offset, offset + 2))
        offset += 2
        continue
      }
      if (offset + 4 > bytes.length) throw new Error('JPEG incompleto')
      const length = view.getUint16(offset + 2)
      const end = offset + length + 2
      if (length < 2 || end > bytes.length) throw new Error('JPEG incompleto')
      if (marker !== 0xe1 && marker !== 0xed) chunks.push(bytes.subarray(offset, end))
      offset = end
    }
    throw new Error('JPEG incompleto')
  }
  if (type === 'image/png') {
    const chunks = [bytes.subarray(0, 8)]
    let offset = 8
    const metadataChunks = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf'])
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset)
      const end = offset + 12 + length
      if (end > bytes.length) throw new Error('PNG incompleto')
      const chunkType = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
      if (!metadataChunks.has(chunkType)) chunks.push(bytes.subarray(offset, end))
      offset = end
      if (chunkType === 'IEND') {
        if (length !== 0) throw new Error('PNG con IEND inválido')
        return concatenate(chunks)
      }
    }
    throw new Error('PNG incompleto')
  }
  return new Uint8Array(bytes)
}

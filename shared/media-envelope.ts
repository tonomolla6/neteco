export type AllowedMediaType = 'image/jpeg' | 'image/png' | 'application/pdf'

export function validateMediaUploadEnvelope(input: { bytes: Uint8Array; declaredType?: string; maximumBytes: number }) {
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1) {
    throw new RangeError('El límite de archivo no es válido')
  }
  if (!input.bytes.byteLength) throw new Error('Falta el archivo')
  if (input.bytes.byteLength > input.maximumBytes) throw new Error('El archivo supera el tamaño permitido')
  const detectedType = detectMediaType(input.bytes)
  if (input.declaredType && input.declaredType !== detectedType && input.declaredType !== 'application/octet-stream') {
    throw new Error('El MIME declarado no coincide con el contenido')
  }
  return detectedType
}

export function detectMediaType(bytes: Uint8Array): AllowedMediaType {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return 'image/png'
  if (bytes.length >= 5 && new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-') return 'application/pdf'
  throw new Error('El contenido no es JPEG, PNG o PDF permitido')
}

export function safeMediaFilename(originalName: string, type: AllowedMediaType, id: string) {
  const base = originalName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .toLowerCase()
  const extension = type === 'image/jpeg' ? 'jpg' : type === 'image/png' ? 'png' : 'pdf'
  return `${id}-${base || 'asset'}.${extension}`
}

import { createConnection } from 'node:net'

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

export function imageDimensions(bytes: Uint8Array, type: AllowedMediaType) {
  const buffer = Buffer.from(bytes)
  if (type === 'image/png') {
    if (buffer.length < 24) throw new Error('PNG incompleto')
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (type === 'image/jpeg') {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buffer[offset + 1]!
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      const length = buffer.readUInt16BE(offset + 2)
      if (length < 2 || offset + length + 2 > buffer.length) throw new Error('JPEG incompleto')
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
      }
      offset += length + 2
    }
    throw new Error('JPEG sin dimensiones válidas')
  }
  return null
}

export function stripMediaMetadata(bytes: Uint8Array, type: AllowedMediaType) {
  const buffer = Buffer.from(bytes)
  if (type === 'image/jpeg') {
    const chunks = [buffer.subarray(0, 2)]
    let offset = 2
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) throw new Error('JPEG inválido durante la normalización')
      const marker = buffer[offset + 1]!
      if (marker === 0xda) {
        chunks.push(buffer.subarray(offset))
        return Buffer.concat(chunks)
      }
      if (marker === 0xd9) {
        chunks.push(buffer.subarray(offset, offset + 2))
        return Buffer.concat(chunks)
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        chunks.push(buffer.subarray(offset, offset + 2))
        offset += 2
        continue
      }
      const length = buffer.readUInt16BE(offset + 2)
      const end = offset + length + 2
      if (length < 2 || end > buffer.length) throw new Error('JPEG incompleto')
      if (marker !== 0xe1 && marker !== 0xed) chunks.push(buffer.subarray(offset, end))
      offset = end
    }
    return Buffer.concat(chunks)
  }
  if (type === 'image/png') {
    const chunks = [buffer.subarray(0, 8)]
    let offset = 8
    const metadataChunks = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf'])
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset)
      const end = offset + 12 + length
      if (end > buffer.length) throw new Error('PNG incompleto')
      const chunkType = buffer.subarray(offset + 4, offset + 8).toString('ascii')
      if (!metadataChunks.has(chunkType)) chunks.push(buffer.subarray(offset, end))
      offset = end
      if (chunkType === 'IEND') break
    }
    return Buffer.concat(chunks)
  }
  return buffer
}

export async function clamAvScan(bytes: Uint8Array, host: string, port: number) {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host, port })
    let response = ''
    socket.setTimeout(15_000)
    socket.on('connect', () => {
      socket.write('zINSTREAM\0')
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        const chunk = bytes.slice(offset, Math.min(offset + 64 * 1024, bytes.length))
        const length = Buffer.allocUnsafe(4)
        length.writeUInt32BE(chunk.byteLength)
        socket.write(length)
        socket.write(chunk)
      }
      socket.write(Buffer.alloc(4))
    })
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => (response += chunk))
    socket.on('timeout', () => socket.destroy(new Error('ClamAV timeout')))
    socket.on('error', reject)
    socket.on('close', () => {
      const result = response.trim()
      if (/\bOK$/.test(result)) resolve(result)
      else if (/\bFOUND$/.test(result)) reject(new Error('El antivirus ha rechazado el archivo'))
      else reject(new Error('Respuesta no válida del antivirus'))
    })
  })
}

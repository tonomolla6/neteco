import { createConnection } from 'node:net'

import type { AllowedMediaType } from '../../shared/media-envelope'
import { stripMediaMetadata as stripMetadataBytes } from '../../shared/media-metadata'
export type { AllowedMediaType } from '../../shared/media-envelope'
export { detectMediaType, safeMediaFilename, validateMediaUploadEnvelope } from '../../shared/media-envelope'

export { imageDimensions } from '../../shared/media-dimensions'

export function stripMediaMetadata(bytes: Uint8Array, type: AllowedMediaType) {
  return Buffer.from(stripMetadataBytes(bytes, type))
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

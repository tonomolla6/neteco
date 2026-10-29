import { FISCAL_MAX_PDF_BYTES, type PrivateFiscalStorage } from '../../shared/fiscal-issuance'
import { checksumFiscalPdf } from '../fiscal/issuance'

const keyPattern =
  /^fiscal\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/([0-9a-f]{64})\.pdf$/
const invalid = () => new Error('fiscal_storage_invalid')

function contentHash(key: string): string {
  const match = keyPattern.exec(key)
  if (!match) throw invalid()
  return match[1]!
}

async function confirmedHash(bytes: Uint8Array, expected: string): Promise<void> {
  try {
    if ((await checksumFiscalPdf(bytes)) !== expected) throw invalid()
  } catch {
    throw invalid()
  }
}

/** Private fiscal objects are never exposed through the public media namespace.
 * A missing object is distinct from an unavailable or corrupted stored document. */
export function createFiscalPdfStorage(bucket: Pick<R2Bucket, 'get' | 'put'>): PrivateFiscalStorage {
  return {
    async put(key, bytes) {
      const expected = contentHash(key)
      if (!(bytes instanceof Uint8Array) || bytes.length < 16 || bytes.length > FISCAL_MAX_PDF_BYTES) throw invalid()
      // Own the input before the first await, including the checksum operation.
      const owned = Uint8Array.from(bytes)
      await confirmedHash(owned, expected)
      const receipt = await bucket.put(key, owned, { httpMetadata: { contentType: 'application/pdf' } })
      if (!receipt || receipt.key !== key || receipt.size !== owned.length)
        throw new Error('fiscal_storage_unconfirmed')
    },
    async get(key) {
      const expected = contentHash(key)
      const object = await bucket.get(key)
      if (object === null) return null
      if (
        !object ||
        object.key !== key ||
        !Number.isSafeInteger(object.size) ||
        object.size < 16 ||
        object.size > FISCAL_MAX_PDF_BYTES ||
        !object.body
      )
        throw invalid()
      const bytes = new Uint8Array(object.size)
      const reader = object.body.getReader()
      let length = 0
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          if (!(part.value instanceof Uint8Array) || part.value.length > bytes.length - length) {
            await reader.cancel().catch(() => {})
            throw invalid()
          }
          bytes.set(part.value, length)
          length += part.value.length
        }
      } finally {
        reader.releaseLock()
      }
      if (length !== bytes.length) throw invalid()
      await confirmedHash(bytes, expected)
      return bytes
    }
  }
}

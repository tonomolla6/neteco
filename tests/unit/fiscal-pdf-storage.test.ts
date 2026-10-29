import { describe, expect, it, vi } from 'vitest'
import { FISCAL_MAX_PDF_BYTES } from '../../shared/fiscal-issuance'
import { checksumFiscalPdf } from '../../workers/fiscal/issuance'
import { createFiscalPdfStorage } from '../../workers/runtime/fiscal-pdf-storage'

const pdf = () => new TextEncoder().encode('%PDF-1.4\nSynthetic private storage fixture\n%%EOF\n')
async function path(bytes: Uint8Array) {
  return `fiscal/80000000-0000-4000-8000-000000000001/${await checksumFiscalPdf(bytes)}.pdf`
}
function bucket(get = vi.fn(), put = vi.fn()) {
  return { get, put } as unknown as Pick<R2Bucket, 'get' | 'put'>
}
function stream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    }
  })
}

describe('private content-addressed fiscal PDF storage', () => {
  it('copies bytes before awaits and confirms the R2 acknowledgement', async () => {
    const input = pdf(),
      original = Uint8Array.from(input),
      key = await path(input)
    const put = vi.fn(async () => ({ key, size: original.length }))
    const pending = createFiscalPdfStorage(bucket(vi.fn(), put)).put(key, input)
    input.fill(42)
    await pending
    expect(put).toHaveBeenCalledWith(key, original, { httpMetadata: { contentType: 'application/pdf' } })
  })

  it.each(['../private.pdf', 'fiscal/not-a-uuid/file.pdf', 'media/existing.pdf'])(
    'rejects an invalid key before R2: %s',
    async (key) => {
      const get = vi.fn(),
        put = vi.fn(),
        storage = createFiscalPdfStorage(bucket(get, put))
      await expect(storage.get(key)).rejects.toThrow('fiscal_storage_invalid')
      await expect(storage.put(key, pdf())).rejects.toThrow('fiscal_storage_invalid')
      expect(get).not.toHaveBeenCalled()
      expect(put).not.toHaveBeenCalled()
    }
  )

  it('does not put bytes under a different content hash', async () => {
    const bytes = pdf(),
      key = (await path(bytes)).replace(/[0-9a-f]{64}(?=\.pdf$)/, '0'.repeat(64))
    const put = vi.fn()
    await expect(createFiscalPdfStorage(bucket(vi.fn(), put)).put(key, bytes)).rejects.toThrow('fiscal_storage_invalid')
    expect(put).not.toHaveBeenCalled()
  })

  it.each([null, undefined, { key: 'wrong', size: 1 }])('does not confirm an invalid PUT receipt', async (receipt) => {
    const bytes = pdf(),
      key = await path(bytes)
    await expect(
      createFiscalPdfStorage(
        bucket(
          vi.fn(),
          vi.fn(async () => receipt)
        )
      ).put(key, bytes)
    ).rejects.toThrow('fiscal_storage_unconfirmed')
  })

  it('returns null only for an absent object, and streams confirmed private bytes', async () => {
    const bytes = pdf(),
      key = await path(bytes)
    expect(await createFiscalPdfStorage(bucket(vi.fn(async () => null))).get(key)).toBeNull()
    const get = vi.fn(async () => ({ key, size: bytes.length, body: stream(bytes) }))
    expect(await createFiscalPdfStorage(bucket(get)).get(key)).toEqual(bytes)
  })

  it('rejects declared oversize without consuming a body', async () => {
    const key = await path(pdf()),
      getReader = vi.fn()
    await expect(
      createFiscalPdfStorage(
        bucket(vi.fn(async () => ({ key, size: FISCAL_MAX_PDF_BYTES + 1, body: { getReader } })))
      ).get(key)
    ).rejects.toThrow('fiscal_storage_invalid')
    expect(getReader).not.toHaveBeenCalled()
  })

  it('cancels a stream whose bytes exceed its declared bounded size', async () => {
    const bytes = pdf(),
      key = await path(bytes),
      cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes)
      },
      cancel
    })
    await expect(createFiscalPdfStorage(bucket(vi.fn(async () => ({ key, size: 16, body })))).get(key)).rejects.toThrow(
      'fiscal_storage_invalid'
    )
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects truncated or hash-mismatched objects instead of treating them as missing', async () => {
    const bytes = pdf(),
      key = await path(bytes)
    const modified = pdf()
    modified[12] = 65
    for (const [size, body] of [
      [bytes.length + 1, stream(bytes)],
      [bytes.length, stream(modified)]
    ] as const)
      await expect(createFiscalPdfStorage(bucket(vi.fn(async () => ({ key, size, body })))).get(key)).rejects.toThrow(
        'fiscal_storage_invalid'
      )
  })
})

export type CatalogXlsxArchiveErrorCode = 'invalid_catalog_file' | 'catalog_file_too_large'

export class CatalogXlsxArchiveError extends Error {
  constructor(
    readonly code: CatalogXlsxArchiveErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CatalogXlsxArchiveError'
  }
}

const CATALOG_XLSX_MAX_EXPANDED_BYTES = 100_000_000
const CATALOG_XLSX_MAX_ENTRIES = 1_000
const ZIP_END_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_LOCAL_SIGNATURE = 0x04034b50

function invalid(message: string): never {
  throw new CatalogXlsxArchiveError('invalid_catalog_file', message)
}

function tooLarge(message: string): never {
  throw new CatalogXlsxArchiveError('catalog_file_too_large', message)
}

function hasZip64Extra(view: DataView, start: number, length: number, limit: number): boolean {
  const end = start + length
  if (end > limit) invalid('Catalog XLSX ZIP extra field is truncated')
  let offset = start
  while (offset < end) {
    if (offset + 4 > end) invalid('Catalog XLSX ZIP extra field is malformed')
    const id = view.getUint16(offset, true)
    const size = view.getUint16(offset + 2, true)
    offset += 4
    if (offset + size > end) invalid('Catalog XLSX ZIP extra field is truncated')
    if (id === 0x0001) return true
    offset += size
  }
  return false
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimumOffset = Math.max(0, view.byteLength - 65_557)
  for (let offset = view.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_END_SIGNATURE) continue
    const commentLength = view.getUint16(offset + 20, true)
    if (offset + 22 + commentLength === view.byteLength) return offset
  }
  return invalid('Catalog XLSX ZIP directory is missing or truncated')
}

function equalBytes(bytes: Uint8Array, left: number, right: number, length: number): boolean {
  for (let index = 0; index < length; index += 1) {
    if (bytes[left + index] !== bytes[right + index]) return false
  }
  return true
}

function safeEntryName(bytes: Uint8Array, start: number, length: number): string {
  if (!length) return invalid('Catalog XLSX contains an empty archive filename')
  let name: string
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, start + length))
  } catch {
    return invalid('Catalog XLSX contains an invalid archive filename')
  }
  if (
    name.startsWith('/') ||
    name.includes('\\') ||
    name.includes(':') ||
    name.includes('\0') ||
    name.split('/').some((part) => part === '.' || part === '..')
  ) {
    return invalid('Catalog XLSX contains an unsafe archive path')
  }
  return name
}

/** Bound advertised ZIP sizes/paths before parsing; the archive reader must still validate the actual inflated content. */
export function inspectCatalogXlsxArchive(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) invalid('Catalog XLSX ZIP archive is truncated')

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = findEndOfCentralDirectory(view)
  const diskNumber = view.getUint16(end + 4, true)
  const directoryDisk = view.getUint16(end + 6, true)
  const entriesOnDisk = view.getUint16(end + 8, true)
  const entries = view.getUint16(end + 10, true)
  const directorySize = view.getUint32(end + 12, true)
  const directoryOffset = view.getUint32(end + 16, true)

  if (
    diskNumber !== 0 ||
    directoryDisk !== 0 ||
    entriesOnDisk !== entries ||
    entries === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    invalid('Catalog XLSX ZIP64 or multi-disk archives are not allowed')
  }
  if (entries > CATALOG_XLSX_MAX_ENTRIES) tooLarge('Catalog XLSX archive exceeds its entry limit')
  if (!entries) invalid('Catalog XLSX ZIP archive is empty')
  if (directoryOffset + directorySize !== end || directoryOffset > end) {
    invalid('Catalog XLSX ZIP directory is malformed')
  }

  let cursor = directoryOffset
  let expandedBytes = 0
  const names = new Set<string>()
  const localRanges: Array<{ start: number; end: number }> = []
  for (let entry = 0; entry < entries; entry += 1) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== ZIP_CENTRAL_SIGNATURE) {
      invalid('Catalog XLSX ZIP directory is malformed')
    }
    const versionNeeded = view.getUint16(cursor + 6, true)
    const flags = view.getUint16(cursor + 8, true)
    const compressionMethod = view.getUint16(cursor + 10, true)
    const checksum = view.getUint32(cursor + 16, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const expandedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const startDisk = view.getUint16(cursor + 34, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength
    if (recordEnd > end || startDisk !== 0) invalid('Catalog XLSX ZIP entry is malformed')
    if (
      versionNeeded >= 45 ||
      compressedSize === 0xffffffff ||
      expandedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      invalid('Catalog XLSX ZIP64 archives are not allowed')
    }
    if (hasZip64Extra(view, cursor + 46 + nameLength, extraLength, recordEnd)) {
      invalid('Catalog XLSX ZIP64 archives are not allowed')
    }
    if (flags & 0x41) invalid('Encrypted catalog XLSX archives are not allowed')
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      invalid('Catalog XLSX uses an unsupported ZIP compression method')
    }

    const nameStart = cursor + 46
    const name = safeEntryName(bytes, nameStart, nameLength)
    if (names.has(name)) invalid('Catalog XLSX contains duplicate archive filenames')
    names.add(name)

    expandedBytes += expandedSize
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > CATALOG_XLSX_MAX_EXPANDED_BYTES) {
      tooLarge('Catalog XLSX expands beyond the 100 MB limit')
    }

    if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== ZIP_LOCAL_SIGNATURE) {
      invalid('Catalog XLSX local file entry is malformed')
    }
    const localFlags = view.getUint16(localOffset + 6, true)
    const localMethod = view.getUint16(localOffset + 8, true)
    const localChecksum = view.getUint32(localOffset + 14, true)
    const localCompressedSize = view.getUint32(localOffset + 18, true)
    const localExpandedSize = view.getUint32(localOffset + 22, true)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataOffset + compressedSize
    if (
      localFlags !== flags ||
      localMethod !== compressionMethod ||
      localNameLength !== nameLength ||
      dataOffset > directoryOffset ||
      dataEnd > directoryOffset ||
      !equalBytes(bytes, localOffset + 30, nameStart, nameLength) ||
      hasZip64Extra(view, localOffset + 30 + localNameLength, localExtraLength, dataOffset)
    ) {
      invalid('Catalog XLSX local file entry is inconsistent')
    }
    if (
      (flags & 0x08) === 0 &&
      (localChecksum !== checksum || localCompressedSize !== compressedSize || localExpandedSize !== expandedSize)
    ) {
      invalid('Catalog XLSX local file entry is inconsistent')
    }
    let localRecordEnd = dataEnd
    if (flags & 0x08) {
      let descriptorOffset = dataEnd
      if (descriptorOffset + 4 <= directoryOffset && view.getUint32(descriptorOffset, true) === 0x08074b50) {
        descriptorOffset += 4
      }
      if (descriptorOffset + 12 > directoryOffset) invalid('Catalog XLSX data descriptor is truncated')
      if (
        view.getUint32(descriptorOffset, true) !== checksum ||
        view.getUint32(descriptorOffset + 4, true) !== compressedSize ||
        view.getUint32(descriptorOffset + 8, true) !== expandedSize
      ) {
        invalid('Catalog XLSX data descriptor is inconsistent')
      }
      localRecordEnd = descriptorOffset + 12
    }
    localRanges.push({ start: localOffset, end: localRecordEnd })
    cursor = recordEnd
  }
  if (cursor !== end) invalid('Catalog XLSX ZIP directory size is inconsistent')

  localRanges.sort((left, right) => left.start - right.start)
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index]!.start < localRanges[index - 1]!.end) {
      invalid('Catalog XLSX local file entries overlap')
    }
  }
}

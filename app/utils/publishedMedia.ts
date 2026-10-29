/** Only governed, same-origin publication IDs can select image derivatives.
 * Never transform an arbitrary URL, an R2 key or a legacy catalog original. */
const PUBLIC_IMAGE_PATH = /^\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/image$/
const PUBLIC_DOCUMENT_PATH =
  /^\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/document$/
const IMAGE_WIDTHS = [64, 128, 256, 400, 640, 800, 1200, 1600] as const
export type PublishedImageFormat = 'avif' | 'webp' | 'jpeg'

export function catalogImageSource(source: string | null | undefined, governed: boolean): string | null {
  return source && (!governed || publicationImagePath(source)) ? source : null
}

export function publishedDocumentUrl(source: string | null | undefined): string | null {
  return source && source.trim() === source && PUBLIC_DOCUMENT_PATH.test(source) ? source : null
}

function publicationImagePath(source: string | null | undefined): string | null {
  if (!source || source.trim() !== source || source.includes('%') || source.includes('#') || source.includes('\\'))
    return null
  const [path, query, extra] = source.split('?')
  if (!path || extra !== undefined || !PUBLIC_IMAGE_PATH.test(path)) return null
  const parameters = new URLSearchParams(query)
  for (const key of parameters.keys()) {
    if (!['w', 'format'].includes(key) || parameters.getAll(key).length !== 1) return null
  }
  const width = parameters.get('w')
  if (width !== null && !IMAGE_WIDTHS.some((allowed) => String(allowed) === width)) return null
  const format = parameters.get('format')
  if (format !== null && !['avif', 'webp', 'jpeg'].includes(format)) return null
  return path
}

export function publishedImageUrl(
  source: string | null | undefined,
  width: (typeof IMAGE_WIDTHS)[number],
  format: PublishedImageFormat = 'jpeg'
): string | null {
  const path = publicationImagePath(source)
  return path ? `${path}?w=${width}&format=${format}` : null
}

export function publishedImageSources(source: string | null | undefined) {
  const path = publicationImagePath(source)
  if (!path) return null
  const srcset = (format: PublishedImageFormat) =>
    IMAGE_WIDTHS.filter((width) => width >= 256)
      .map((width) => `${path}?w=${width}&format=${format} ${width}w`)
      .join(', ')
  return {
    jpeg: `${path}?w=800&format=jpeg`,
    jpegSrcset: srcset('jpeg'),
    webpSrcset: srcset('webp'),
    avifSrcset: srcset('avif')
  }
}

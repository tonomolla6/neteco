export type PublicationRole = 'main' | 'image' | 'datasheet' | 'sds' | 'certificate' | 'label'

export interface PublicationFormInput {
  productId: string
  variantId: string | null
  mimeType: string
  role: PublicationRole
  title: string
  altText: string
  language: string
  version: string
  validFromLocal: string
  validUntilLocal: string
}

export interface MediaPublicationPayload {
  productId: string
  variantId: string | null
  role: PublicationRole
  title: string
  altText: string
  language: string
  version: string
  validFrom: string
  validUntil: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ROLE_LABELS: Record<PublicationRole, string> = {
  main: 'Imagen principal',
  image: 'Imagen adicional',
  datasheet: 'Ficha técnica',
  sds: 'Ficha de seguridad',
  certificate: 'Certificado',
  label: 'Etiqueta'
}

export function publicationRoles(mimeType: string): Array<{ label: string; value: PublicationRole }> {
  const roles: PublicationRole[] =
    mimeType === 'application/pdf'
      ? ['datasheet', 'sds', 'certificate', 'label']
      : mimeType === 'image/jpeg' || mimeType === 'image/png'
        ? ['main', 'image', 'label']
        : []
  return roles.map((value) => ({ value, label: ROLE_LABELS[value] }))
}

export function publicationLocalTime(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Reject normalized impossible dates and DST gaps; the server validates UTC
 * independently. The form's local time is never sent as a database timestamp. */
function localToUtc(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const canonicalLocal = value.length === 16 ? `${value}:00` : value
  if (publicationLocalTime(date) !== canonicalLocal) return null
  return date.toISOString().replace('.000Z', 'Z')
}

/** Whitelisted contract only: no URL, R2 key, rights or scanner evidence can be
 * manufactured by the panel. A null result disables submission. */
export function buildMediaPublicationPayload(input: PublicationFormInput): MediaPublicationPayload | null {
  if (!UUID.test(input.productId) || (input.variantId !== null && !UUID.test(input.variantId))) return null
  if (!publicationRoles(input.mimeType).some(({ value }) => value === input.role)) return null
  const title = input.title.trim()
  const altText = input.altText.trim()
  const language = input.language.trim()
  const version = input.version.trim()
  if (
    title.length < 1 ||
    title.length > 200 ||
    altText.length < 5 ||
    altText.length > 500 ||
    !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language) ||
    language.length > 35 ||
    version.length < 1 ||
    version.length > 100 ||
    [title, altText, version].some((value) =>
      Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
  )
    return null
  const validFrom = localToUtc(input.validFromLocal)
  const validUntil = input.validUntilLocal ? localToUtc(input.validUntilLocal) : null
  if (!validFrom || (input.validUntilLocal && !validUntil) || (validUntil && validUntil <= validFrom)) return null
  return {
    productId: input.productId.toLowerCase(),
    variantId: input.variantId?.toLowerCase() ?? null,
    role: input.role,
    title,
    altText,
    language,
    version,
    validFrom,
    validUntil
  }
}

/** Never render arbitrary backend messages, URLs or object keys in the panel. */
export function mediaPublicationError(cause: unknown): string {
  const messages: Record<string, string> = {
    forbidden: 'Ya no tienes permiso para publicar. Actualiza la biblioteca.',
    unauthenticated: 'La sesión ha caducado. Vuelve a iniciar sesión.',
    mfa_required: 'Debes verificar el segundo factor antes de publicar.',
    media_not_publishable: 'El archivo ya no cumple los requisitos de publicación. Actualiza la biblioteca.',
    conflict: 'El estado ha cambiado. Actualiza la biblioteca y revisa la asociación.',
    invalid_input: 'Revisa los campos de la asociación y su vigencia.',
    rate_limited: 'Has realizado demasiadas operaciones. Espera antes de reintentar.'
  }
  const code = (cause as { data?: { error?: { code?: unknown } } } | null)?.data?.error?.code
  return (
    (typeof code === 'string' && Object.hasOwn(messages, code) ? messages[code] : undefined) ??
    'No se ha podido asociar el archivo. Puedes reintentar sin duplicar la operación.'
  )
}

import { isCanonicalInventoryInstant } from '../catalog/inventory'
import { escapeEmailHtml } from './order-created-email'

export type IdentityEmailPurpose = 'verify_email' | 'password_reset' | 'email_change'

export interface IdentityEmailSnapshot {
  purpose: IdentityEmailPurpose
  token: string
  publicOrigin: string
  expiresAt: string
  displayName?: string | null
}

export function isIdentityEmailMailbox(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 254 || /\s/.test(value)) return false
  const parts = value.split('@')
  if (parts.length !== 2) return false
  const local = parts[0]!
  const labels = parts[1]!.split('.')
  return (
    local.length <= 64 &&
    /^[a-zA-Z0-9._%+-]+$/.test(local) &&
    !local.startsWith('.') &&
    !local.endsWith('.') &&
    !local.includes('..') &&
    labels.length >= 2 &&
    /^[a-zA-Z]{2,63}$/.test(labels.at(-1)!) &&
    labels.every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))
  )
}

export function assertIdentityEmailOrigin(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('invalid_identity_email_origin')
  let origin: URL
  try {
    origin = new URL(value)
  } catch {
    throw new Error('invalid_identity_email_origin')
  }
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== value ||
    origin.username ||
    origin.password ||
    origin.hostname.endsWith('.invalid')
  )
    throw new Error('invalid_identity_email_origin')
}

export function isIdentityEmailDisplayName(value: unknown): value is string | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 200 &&
      !Array.from(value).some((character) => {
        const code = character.charCodeAt(0)
        return (code < 32 && ![9, 10, 13].includes(code)) || code === 127
      }))
  )
}

/** One security/transactional stream, independent of marketing consent. Only
 * the HTTPS server configuration can choose the origin; no redirect is accepted.
 */
export function renderIdentityEmail(snapshot: IdentityEmailSnapshot): {
  subject: string
  html: string
  text: string
} {
  assertIdentityEmailOrigin(snapshot.publicOrigin)
  if (
    !['verify_email', 'password_reset', 'email_change'].includes(snapshot.purpose) ||
    !/^[A-Za-z0-9_-]{43}$/.test(snapshot.token) ||
    !isCanonicalInventoryInstant(snapshot.expiresAt) ||
    !isIdentityEmailDisplayName(snapshot.displayName)
  )
    throw new Error('invalid_identity_email_content')
  const copy = {
    verify_email: {
      title: 'Verifica tu correo electrónico',
      explanation: 'Confirma esta dirección de correo para tu cuenta de NETECO.',
      action: 'Verificar correo electrónico',
      path: '/verificar-email'
    },
    password_reset: {
      title: 'Restablece tu contraseña',
      explanation: 'Has solicitado restablecer la contraseña de tu cuenta de NETECO.',
      action: 'Restablecer contraseña',
      path: '/restablecer-clave'
    },
    email_change: {
      title: 'Confirma tu nueva dirección de correo',
      explanation: 'Confirma esta dirección para completar el cambio de correo de tu cuenta de NETECO.',
      action: 'Confirmar nueva dirección',
      path: '/verificar-email'
    }
  }[snapshot.purpose]
  const url = new URL(copy.path, snapshot.publicOrigin)
  url.searchParams.set('token', snapshot.token)
  const link = url.toString()
  const name = snapshot.displayName?.replace(/\s+/g, ' ').trim()
  const greeting = name ? `Hola ${name},` : 'Hola,'
  const expiration = `El enlace es de un solo uso y caduca el ${snapshot.expiresAt.slice(0, 10)} a las ${snapshot.expiresAt.slice(11, 19)} (UTC).`
  const warning = 'Si no has solicitado esta acción, ignora este mensaje. No compartas este enlace.'
  return {
    subject: `NETECO: ${copy.title}`,
    html: `<!doctype html><html lang="es"><body><p>${escapeEmailHtml(greeting)}</p><h1>${copy.title}</h1><p>${copy.explanation}</p><p><a href="${escapeEmailHtml(link)}">${copy.action}</a></p><p>${escapeEmailHtml(expiration)}</p><p>${warning}</p></body></html>`,
    text: `${greeting}\n\n${copy.title}\n${copy.explanation}\n\n${link}\n\n${expiration}\n${warning}`
  }
}

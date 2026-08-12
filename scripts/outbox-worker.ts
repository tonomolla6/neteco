import postgres from 'postgres'
import { emailProviderFromEnvironment } from '../server/integrations/email-provider'
import { decryptSecret } from '../server/utils/secrets'

interface OutboxEvent {
  id: string
  eventType: string
  payload: {
    recipient: string
    name?: string
    tokenEnvelope?: string
    expiresAt?: string
    occurredAt?: string
  }
  attempts: number
}

const connection = process.env.DATABASE_URL?.trim()
const encryptionKey = process.env.AUTH_ENCRYPTION_KEY?.trim()
const baseUrl = process.env.APP_BASE_URL?.trim()
if (!connection) throw new Error('DATABASE_URL is required')
if (!encryptionKey) throw new Error('AUTH_ENCRYPTION_KEY is required')
if (!baseUrl) throw new Error('APP_BASE_URL is required')

const sql = postgres(connection, { max: 2, connect_timeout: 10 })
const provider = emailProviderFromEnvironment()
const workerId = `email-${process.pid}`

async function claim(): Promise<OutboxEvent | undefined> {
  return sql.begin(async (transaction) => {
    const [event] = await transaction<OutboxEvent[]>`
      SELECT id, event_type AS "eventType", payload, attempts
      FROM outbox_events
      WHERE status IN ('pending', 'retry')
        AND available_at <= now()
        AND event_type IN (
          'identity.verification.requested', 'identity.password_reset.requested',
          'identity.email_change.requested', 'identity.security.password_changed',
          'identity.security.email_changed'
        )
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `
    if (!event) return undefined
    await transaction`
      UPDATE outbox_events
      SET status = 'processing', attempts = attempts + 1, locked_at = now(), locked_by = ${workerId}
      WHERE id = ${event.id}
    `
    return { ...event, attempts: event.attempts + 1 }
  })
}

function render(event: OutboxEvent) {
  const displayName = event.payload.name?.trim() || 'Hola'
  const safeName = displayName
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
  if (event.eventType === 'identity.security.password_changed') {
    return {
      messageId: event.id,
      to: event.payload.recipient,
      subject: 'Tu contraseña de NETECO ha cambiado',
      text: `${displayName}: la contraseña de tu cuenta NETECO ha cambiado. Si no has sido tú, contacta con soporte de inmediato.`,
      html: `<p>${safeName}:</p><p>La contraseña de tu cuenta NETECO ha cambiado.</p><p>Si no has sido tú, contacta con soporte de inmediato.</p>`
    }
  }
  if (event.eventType === 'identity.security.email_changed') {
    return {
      messageId: event.id,
      to: event.payload.recipient,
      subject: 'El email de tu cuenta NETECO ha cambiado',
      text: `${displayName}: el email de acceso a tu cuenta NETECO ha cambiado. Si no has sido tú, contacta con soporte de inmediato.`,
      html: `<p>${safeName}:</p><p>El email de acceso a tu cuenta NETECO ha cambiado.</p><p>Si no has sido tú, contacta con soporte de inmediato.</p>`
    }
  }
  if (!event.payload.tokenEnvelope || !event.payload.expiresAt) throw new Error('Email token payload is incomplete')
  const token = decryptSecret(event.payload.tokenEnvelope, encryptionKey!)
  const verification = event.eventType === 'identity.verification.requested'
  const emailChange = event.eventType === 'identity.email_change.requested'
  const path = verification || emailChange ? '/verificar-email' : '/restablecer-clave'
  const link = new URL(path, baseUrl)
  link.searchParams.set('token', token)
  const subject = verification
    ? 'Verifica tu cuenta de NETECO'
    : emailChange
      ? 'Confirma tu nuevo email de NETECO'
      : 'Restablece tu contraseña de NETECO'
  const action = verification
    ? 'verificar tu dirección de correo'
    : emailChange
      ? 'confirmar el nuevo email de tu cuenta'
      : 'elegir una nueva contraseña'
  const safeLink = link.toString().replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  return {
    messageId: event.id,
    to: event.payload.recipient,
    subject,
    text: `${displayName}: usa este enlace para ${action}: ${link.toString()}\nCaduca: ${event.payload.expiresAt}`,
    html: `<p>${safeName}:</p><p><a href="${safeLink}">Pulsa aquí para ${action}</a>.</p><p>El enlace caduca en la fecha indicada en este mensaje.</p>`
  }
}

async function processOne(event: OutboxEvent) {
  try {
    await provider.send(render(event))
    await sql`
      UPDATE outbox_events
      SET status = 'completed', completed_at = now(), locked_at = NULL, locked_by = NULL,
          last_error_code = NULL, last_error_message = NULL
      WHERE id = ${event.id} AND locked_by = ${workerId}
    `
  } catch (error) {
    const terminal = event.attempts >= 10
    const delaySeconds = Math.min(2 ** event.attempts * 30, 3600)
    await sql`
      UPDATE outbox_events
      SET status = ${terminal ? 'dead' : 'retry'}, available_at = now() + (${delaySeconds} * interval '1 second'),
          locked_at = NULL, locked_by = NULL, last_error_code = 'email_delivery_failed',
          last_error_message = ${error instanceof Error ? error.message.slice(0, 500) : 'unknown'}
      WHERE id = ${event.id} AND locked_by = ${workerId}
    `
    if (terminal) process.exitCode = 1
  }
}

try {
  const once = process.argv.includes('--once')
  do {
    const event = await claim()
    if (!event) break
    await processOne(event)
  } while (!once)
} finally {
  await sql.end({ timeout: 5 })
}

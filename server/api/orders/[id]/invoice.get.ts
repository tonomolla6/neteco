import { createHash } from 'node:crypto'
import { invoiceProviderFromEnvironment } from '../../../integrations/invoice-factory'
import { useDatabase } from '../../../db/client'
import { hashAccessToken } from '../../../utils/access-token'

export default defineEventHandler(async (event) => {
  const publicNumber = getRouterParam(event, 'id')
  if (!publicNumber) throw createError({ statusCode: 404, statusMessage: 'Factura no encontrada' })
  const cookie = getCookie(event, 'neteco-order-access')
  const cookieToken = cookie?.startsWith(`${publicNumber}.`) ? cookie.slice(publicNumber.length + 1) : undefined
  const queryToken = String(getQuery(event).token ?? cookieToken ?? '')
  const session = await getUserSession(event)
  const sql = useDatabase()
  const [invoice] = await sql<
    Array<{
      providerInvoiceId: string
      providerCode: string
      checksum: string
    }>
  >`
    SELECT invoice.provider_invoice_id AS "providerInvoiceId", invoice.provider_code AS "providerCode",
           invoice.pdf_checksum AS checksum
    FROM invoices invoice
    JOIN orders orders ON orders.id = invoice.order_id
    WHERE orders.public_number = ${publicNumber}
      AND invoice.kind = 'invoice' AND invoice.status IN ('issued', 'fiscal_pending')
      AND invoice.provider_invoice_id IS NOT NULL AND invoice.pdf_checksum IS NOT NULL
      AND (
        (${queryToken} <> '' AND orders.guest_access_hash = ${hashAccessToken(queryToken)})
        OR EXISTS (
          SELECT 1 FROM identities identity
          JOIN auth_sessions active ON active.identity_id = identity.id
          WHERE identity.customer_id = orders.customer_id
            AND identity.id = ${session.user?.id ?? null}
            AND active.id = ${session.sessionId ?? null}
            AND active.revoked_at IS NULL AND active.expires_at > now()
            AND active.session_version = identity.session_version
        )
      )
  `
  if (!invoice) throw createError({ statusCode: 404, statusMessage: 'Factura no encontrada' })
  const provider = invoiceProviderFromEnvironment()
  let pdf: Uint8Array
  try {
    pdf = await provider.downloadPdf(invoice.providerInvoiceId)
  } catch {
    throw createError({ statusCode: 503, statusMessage: 'La factura no está disponible temporalmente' })
  }
  const checksum = createHash('sha256').update(pdf).digest('hex')
  if (checksum !== invoice.checksum) {
    throw createError({ statusCode: 502, statusMessage: 'La integridad de la factura no se puede verificar' })
  }
  const filename = `factura-${invoice.providerCode.replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`
  setResponseHeaders(event, {
    'content-type': 'application/pdf',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'private, no-store',
    'content-length': pdf.byteLength
  })
  return Buffer.from(pdf)
})

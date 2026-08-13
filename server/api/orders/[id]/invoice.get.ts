import { createHash } from 'node:crypto'
import { invoiceProviderFromEnvironment } from '../../../integrations/invoice-factory'
import { useDatabase } from '../../../db/client'
import { hashAccessToken } from '../../../utils/access-token'

export default defineEventHandler(async (event) => {
  const publicNumber = getRouterParam(event, 'id')
  if (!publicNumber) throw createError({ statusCode: 404, statusMessage: 'Factura no encontrada' })
  const cookie = getCookie(event, 'neteco-order-access')
  const cookieToken = cookie?.startsWith(`${publicNumber}.`) ? cookie.slice(publicNumber.length + 1) : undefined
  const accessToken = cookieToken ?? ''
  const documentId = String(getQuery(event).document ?? '')
  const kind = getQuery(event).kind === 'credit_note' ? 'credit_note' : 'invoice'
  if (documentId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(documentId)) {
    throw createError({ statusCode: 400, statusMessage: 'Documento inválido' })
  }
  const session = await getUserSession(event)
  const sql = useDatabase()
  const [invoice] = await sql<
    Array<{
      providerInvoiceId: string
      providerCode: string
      checksum: string | null
      pdfBytes: Uint8Array | null
      invoiceId: string
    }>
  >`
    SELECT invoice.provider_invoice_id AS "providerInvoiceId", invoice.provider_code AS "providerCode",
           invoice.pdf_checksum AS checksum, invoice.pdf_bytes AS "pdfBytes", invoice.id AS "invoiceId"
    FROM invoices invoice
    JOIN orders orders ON orders.id = invoice.order_id
    WHERE orders.public_number = ${publicNumber}
      AND invoice.kind = ${kind} AND invoice.status IN ('issued', 'fiscal_pending')
      AND invoice.provider_invoice_id IS NOT NULL
      AND (${documentId} = '' OR invoice.id = ${documentId || null}::uuid)
      AND (
        EXISTS (
          SELECT 1 FROM order_access_sessions guest_session
          WHERE guest_session.order_id = orders.id
            AND guest_session.token_hash = ${hashAccessToken(accessToken)}
            AND guest_session.revoked_at IS NULL AND guest_session.expires_at > now()
        )
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
    ORDER BY invoice.fiscal_version DESC
    LIMIT 1
  `
  if (!invoice) throw createError({ statusCode: 404, statusMessage: 'Factura no encontrada' })
  let pdf = invoice.pdfBytes
  if (!pdf) {
    const provider = invoiceProviderFromEnvironment()
    try {
      pdf = await provider.downloadPdf(invoice.providerInvoiceId)
    } catch {
      throw createError({ statusCode: 503, statusMessage: 'La factura no está disponible temporalmente' })
    }
  }
  const checksum = createHash('sha256').update(pdf).digest('hex')
  if (invoice.checksum && checksum !== invoice.checksum) {
    throw createError({ statusCode: 502, statusMessage: 'La integridad de la factura no se puede verificar' })
  }
  if (!invoice.pdfBytes) {
    await sql`
      UPDATE invoices SET pdf_bytes = ${Buffer.from(pdf)}, pdf_size = ${pdf.byteLength},
        pdf_checksum = ${checksum}, updated_at = now()
      WHERE id = ${invoice.invoiceId} AND pdf_bytes IS NULL
    `
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

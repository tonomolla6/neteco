import { z } from 'zod'
import { COMPANY_STATUSES, companyStatusCanTransition, type CompanyStatus } from '../../../domain/company'
import { useDatabase } from '../../../db/client'

const paramsSchema = z.object({ id: z.string().uuid() })
const schema = z.object({
  status: z.enum(COMPANY_STATUSES),
  reason: z.string().trim().min(3).max(500)
})

export default defineEventHandler(async (event) => {
  const administrator = await requireAdmin(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const body = await readValidatedBody(event, schema.parse)
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const result = await sql.begin(async (transaction) => {
    const [company] = await transaction<{ status: CompanyStatus; taxId: string | null }[]>`
      SELECT status, tax_id AS "taxId" FROM companies WHERE id = ${id} FOR UPDATE
    `
    if (!company) throw createError({ statusCode: 404, statusMessage: 'Empresa no encontrada' })
    if (!companyStatusCanTransition(company.status, body.status)) {
      throw createError({
        statusCode: 409,
        statusMessage: `Transición ${company.status} → ${body.status} no permitida`
      })
    }
    if (body.status === 'approved' && !company.taxId) {
      throw createError({ statusCode: 409, statusMessage: 'No se puede aprobar sin identificador fiscal' })
    }
    await transaction`
      UPDATE companies SET status = ${body.status},
                           rejection_reason = ${body.status === 'rejected' || body.status === 'suspended' ? body.reason : null},
                           reviewed_by = ${administrator.id}, reviewed_at = now(), updated_at = now()
      WHERE id = ${id}
    `
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id,
        before_redacted, after_redacted, reason, correlation_id
      ) VALUES (
        'staff', ${administrator.id}, 'company.status.changed', 'company', ${id},
        ${transaction.json({ status: company.status })}, ${transaction.json({ status: body.status })},
        ${body.reason}, ${correlationId}
      )
    `
    return { id, status: body.status }
  })
  return result
})

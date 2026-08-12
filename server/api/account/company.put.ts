import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { normalizeTaxId, taxIdFormatIsValid } from '../../domain/customer'
import { redactTaxId } from '../../domain/company'
import { requireCustomerAccount } from '../../utils/account'
import { identityProfile, refreshAuthenticatedSession } from '../../utils/auth-session'
import { enforceRateLimit } from '../../utils/rate-limit'

const schema = z.object({
  legalName: z.string().trim().min(2).max(200),
  tradeName: z.string().trim().max(200).optional().default(''),
  taxId: z.string().trim().min(3).max(32),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/),
  currentPassword: z.string().min(1).max(128)
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  const account = await requireCustomerAccount(event)
  await enforceRateLimit(event, {
    scope: 'professional-account',
    subject: account.profile.id,
    limit: 5,
    windowSeconds: 3600
  })
  if (account.profile.mfaEnabled && !account.mfaVerified) {
    throw createError({ statusCode: 403, statusMessage: 'Confirma tu MFA antes de modificar datos fiscales' })
  }
  const taxId = normalizeTaxId(body.taxId)
  if (!taxIdFormatIsValid(body.countryCode, taxId)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'El identificador fiscal no tiene un formato válido para el país'
    })
  }
  const sql = useDatabase()
  const [identity] = await sql<{ passwordHash: string }[]>`
    SELECT password_hash AS "passwordHash" FROM identities WHERE id = ${account.profile.id}
  `
  if (!identity || !(await verifyPassword(identity.passwordHash, body.currentPassword))) {
    throw createError({ statusCode: 401, statusMessage: 'La contraseña actual no es correcta' })
  }
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  let companyId: string
  try {
    companyId = await sql.begin(async (transaction) => {
      const [membership] = await transaction<
        Array<{ companyId: string; role: string; legalName: string; taxId: string | null; status: string }>
      >`
        SELECT member.company_id AS "companyId", member.role, company.legal_name AS "legalName",
               company.tax_id AS "taxId", company.status
        FROM company_members member JOIN companies company ON company.id = member.company_id
        WHERE member.identity_id = ${account.profile.id} AND member.status = 'active'
        ORDER BY member.accepted_at NULLS LAST LIMIT 1 FOR UPDATE OF company
      `
      if (membership && membership.role !== 'company_admin') {
        throw createError({
          statusCode: 403,
          statusMessage: 'Solo el administrador de empresa puede modificar datos fiscales'
        })
      }
      if (membership) {
        const fiscalChanged = membership.legalName !== body.legalName || membership.taxId !== taxId
        await transaction`
          UPDATE companies SET legal_name = ${body.legalName}, trade_name = ${body.tradeName || null},
                               tax_id = ${taxId}, country_code = ${body.countryCode},
                               status = ${fiscalChanged ? 'pending' : membership.status},
                               reviewed_by = CASE WHEN ${fiscalChanged} THEN NULL ELSE reviewed_by END,
                               reviewed_at = CASE WHEN ${fiscalChanged} THEN NULL ELSE reviewed_at END,
                               rejection_reason = CASE WHEN ${fiscalChanged} THEN NULL ELSE rejection_reason END,
                               updated_at = now()
          WHERE id = ${membership.companyId}
        `
        await transaction`
          INSERT INTO audit_log (
            actor_type, actor_id, action, resource_type, resource_id, before_redacted, after_redacted, correlation_id
          ) VALUES (
            'identity', ${account.profile.id}, 'company.fiscal_data.updated', 'company', ${membership.companyId},
            ${transaction.json({ legalName: membership.legalName, taxId: redactTaxId(membership.taxId), status: membership.status })},
            ${transaction.json({ legalName: body.legalName, taxId: redactTaxId(taxId), status: fiscalChanged ? 'pending' : membership.status })},
            ${correlationId}
          )
        `
        return membership.companyId
      }
      const [company] = await transaction<{ id: string }[]>`
        INSERT INTO companies (legal_name, trade_name, tax_id, country_code, status)
        VALUES (${body.legalName}, ${body.tradeName || null}, ${taxId}, ${body.countryCode}, 'pending') RETURNING id
      `
      if (!company) throw new Error('Company insert returned no row')
      const [location] = await transaction<{ id: string }[]>`
        INSERT INTO company_locations (company_id, name, code, billing_email)
        VALUES (${company.id}, 'Sede principal', 'MAIN', ${account.profile.email}) RETURNING id
      `
      await transaction`
        INSERT INTO company_members (company_id, location_id, identity_id, role, status, accepted_at)
        VALUES (${company.id}, ${location?.id ?? null}, ${account.profile.id}, 'company_admin', 'active', now())
      `
      await transaction`
        INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id, after_redacted, correlation_id)
        VALUES (
          'identity', ${account.profile.id}, 'company.professional_account.requested', 'company', ${company.id},
          ${transaction.json({ legalName: body.legalName, taxId: redactTaxId(taxId), status: 'pending' })},
          ${correlationId}
        )
      `
      return company.id
    })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw createError({ statusCode: 409, statusMessage: 'Ya existe una empresa con ese identificador fiscal' })
    }
    throw error
  }
  const profile = await identityProfile(account.profile.id)
  if (!profile) throw new Error('Updated identity is not readable')
  const user = await refreshAuthenticatedSession(event, profile, account.mfaVerified, account.session.sessionId!)
  return { companyId, status: 'pending', user }
})

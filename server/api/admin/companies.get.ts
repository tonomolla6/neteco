import { useDatabase } from '../../db/client'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const sql = useDatabase()
  const companies = await sql`
    SELECT company.id, company.legal_name AS "legalName", company.trade_name AS "tradeName",
           company.tax_id AS "taxId", company.country_code AS "countryCode", company.status,
           company.rejection_reason AS "rejectionReason", company.created_at AS "createdAt",
           company.reviewed_at AS "reviewedAt", reviewer.email::text AS "reviewedBy",
           count(DISTINCT location.id)::int AS locations, count(DISTINCT member.identity_id)::int AS members,
           min(identity.email)::text AS "contactEmail"
    FROM companies company
    LEFT JOIN company_locations location ON location.company_id = company.id
    LEFT JOIN company_members member ON member.company_id = company.id AND member.status = 'active'
    LEFT JOIN identities identity ON identity.id = member.identity_id
    LEFT JOIN identities reviewer ON reviewer.id = company.reviewed_by
    GROUP BY company.id, reviewer.email
    ORDER BY CASE company.status WHEN 'pending' THEN 0 ELSE 1 END, company.created_at DESC
    LIMIT 500
  `
  return { companies }
})

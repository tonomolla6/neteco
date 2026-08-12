import { useDatabase } from '../../db/client'
import { requireCustomerAccount } from '../../utils/account'

export default defineEventHandler(async (event) => {
  const account = await requireCustomerAccount(event)
  const sql = useDatabase()
  const [profile] = await sql<
    Array<{
      name: string | null
      phone: string | null
      email: string
      companyId: string | null
      company: string | null
      tradeName: string | null
      taxId: string | null
      countryCode: string | null
      companyStatus: string | null
      companyRole: string | null
    }>
  >`
    SELECT customer.name, customer.phone, identity.email::text,
           company.id AS "companyId", company.legal_name AS company,
           company.trade_name AS "tradeName", company.tax_id AS "taxId",
           company.country_code AS "countryCode", company.status AS "companyStatus",
           membership.role AS "companyRole"
    FROM identities identity
    JOIN customers customer ON customer.id = identity.customer_id
    LEFT JOIN LATERAL (
      SELECT member.company_id, member.role
      FROM company_members member
      WHERE member.identity_id = identity.id AND member.status = 'active'
      ORDER BY member.accepted_at NULLS LAST
      LIMIT 1
    ) membership ON true
    LEFT JOIN companies company ON company.id = membership.company_id
    WHERE identity.id = ${account.profile.id}
  `
  setResponseHeader(event, 'cache-control', 'private, no-store')
  return { profile }
})

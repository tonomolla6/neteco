export const COMPANY_STATUSES = ['pending', 'approved', 'rejected', 'suspended'] as const
export type CompanyStatus = (typeof COMPANY_STATUSES)[number]

const COMPANY_TRANSITIONS: Record<CompanyStatus, readonly CompanyStatus[]> = {
  pending: ['approved', 'rejected'],
  approved: ['suspended'],
  rejected: ['pending'],
  suspended: ['pending', 'approved']
}

export function companyStatusCanTransition(from: CompanyStatus, to: CompanyStatus) {
  return from === to || COMPANY_TRANSITIONS[from].includes(to)
}

export function redactTaxId(value: string | null) {
  if (!value) return null
  return value.length <= 4 ? '*'.repeat(value.length) : `${'*'.repeat(value.length - 4)}${value.slice(-4)}`
}

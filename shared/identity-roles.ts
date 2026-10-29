const ROLE_PRIORITY = ['admin', 'finance', 'publisher', 'catalog_editor', 'warehouse', 'support', 'customer']

/** Display priority only. Authorization must check live permission grants. */
export function primaryRole(roles: string[]) {
  return ROLE_PRIORITY.find((role) => roles.includes(role)) ?? 'customer'
}

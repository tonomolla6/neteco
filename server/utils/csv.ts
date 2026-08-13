const FORMULA_PREFIX = /^[\t\r\n ]*[=+\-@]/

export function safeCsvValue(value: string | number) {
  const text = String(value)
  return FORMULA_PREFIX.test(text) ? `'${text}` : text
}

export function csvCell(value: string | number) {
  return `"${safeCsvValue(value).replaceAll('"', '""')}"`
}

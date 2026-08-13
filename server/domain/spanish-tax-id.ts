const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE'
const CIF_CONTROL_LETTERS = 'JABCDEFGHI'

export function normalizeSpanishTaxId(value: string) {
  return value.toUpperCase().replace(/[\s-]/g, '')
}

function validDni(value: string) {
  const match = /^(\d{8})([A-Z])$/.exec(value)
  return !!match && DNI_LETTERS[Number(match[1]) % 23] === match[2]
}

function validNie(value: string) {
  const match = /^([XYZ])(\d{7})([A-Z])$/.exec(value)
  if (!match) return false
  const prefix = { X: '0', Y: '1', Z: '2' }[match[1] as 'X' | 'Y' | 'Z']
  return DNI_LETTERS[Number(`${prefix}${match[2]}`) % 23] === match[3]
}

function validCif(value: string) {
  const match = /^([ABCDEFGHJNPQRSUVW])(\d{7})([0-9A-J])$/.exec(value)
  if (!match) return false
  const digits = match[2]!
  let checksum = 0
  for (const [index, digit] of [...digits].entries()) {
    const number = Number(digit)
    if (index % 2 === 0) {
      const doubled = number * 2
      checksum += Math.floor(doubled / 10) + (doubled % 10)
    } else {
      checksum += number
    }
  }
  const control = (10 - (checksum % 10)) % 10
  const supplied = match[3]!
  if ('ABEH'.includes(match[1]!)) return supplied === String(control)
  if ('KPQSNW'.includes(match[1]!)) return supplied === CIF_CONTROL_LETTERS[control]
  return supplied === String(control) || supplied === CIF_CONTROL_LETTERS[control]
}

export function isValidSpanishTaxId(value: string) {
  const normalized = normalizeSpanishTaxId(value)
  return validDni(normalized) || validNie(normalized) || validCif(normalized)
}

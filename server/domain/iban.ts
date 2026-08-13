export function normalizeIban(value: string) {
  return value.replace(/\s+/g, '').toUpperCase()
}

export function validIban(value: string) {
  const normalized = normalizeIban(value)
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(normalized)) return false
  const rearranged = `${normalized.slice(4)}${normalized.slice(0, 4)}`
  let remainder = 0
  for (const character of rearranged) {
    const digits = /[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}

export function displayIban(value: string) {
  return normalizeIban(value)
    .replace(/(.{4})/g, '$1 ')
    .trim()
}

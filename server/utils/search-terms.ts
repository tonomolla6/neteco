export function normalizeSearchTerm(value: string) {
  return value.trim().replace(/\s+/g, ' ').slice(0, 160)
}

export function uniqueSearchTerms(source: string, replacements: string[][]) {
  const terms = [
    normalizeSearchTerm(source),
    ...replacements.flatMap((items) => items.map(normalizeSearchTerm))
  ].filter((term) => term.length >= 2)
  return [...new Set(terms.map((term) => term.toLocaleLowerCase('es-ES')))].slice(0, 20)
}

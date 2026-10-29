/** Original module evidence must not depend on a source-map filename alone.
 * In particular, a sourceRoot can contain the package/builtin which a relative
 * source name would otherwise hide from the Worker dependency policy. */
export function originalWorkerSources(input: unknown): string[] {
  const sources = new Set<string>()
  let maps = 0
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
  const validPath = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.length > 0 &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  const fail = () => {
    throw new Error('invalid_worker_source_map_evidence')
  }
  function visit(value: unknown, depth: number) {
    if (!record(value) || value.version !== 3 || depth > 16 || ++maps > 10_000) fail()
    const map = value as Record<string, unknown>
    if ('sections' in map) {
      if ('sources' in map || 'sourceRoot' in map || !Array.isArray(map.sections)) fail()
      const sections = map.sections as unknown[]
      if (!sections.length) fail()
      for (const section of sections) {
        if (!record(section) || !record(section.offset) || 'url' in section || !('map' in section)) fail()
        const entry = section as Record<string, unknown>
        const offset = entry.offset as Record<string, unknown>
        if (
          !Number.isSafeInteger(offset.line) ||
          (offset.line as number) < 0 ||
          !Number.isSafeInteger(offset.column) ||
          (offset.column as number) < 0
        )
          fail()
        visit(entry.map, depth + 1)
      }
      return
    }
    if (!Array.isArray(map.sources)) fail()
    if ('sourceRoot' in map && typeof map.sourceRoot !== 'string') fail()
    const root = ((map.sourceRoot as string | undefined) ?? '').replaceAll('\\', '/')
    if (root && !validPath(root)) fail()
    for (const source of map.sources as unknown[]) {
      if (!validPath(source)) fail()
      const path = (source as string).replaceAll('\\', '/')
      // Absolute paths and URIs already identify their source. Otherwise retain
      // the root; do not discard it when checking original dependency evidence.
      const qualified = !root || /^(?:\/|[a-z][a-z\d+.-]*:)/i.test(path) ? path : `${root.replace(/\/$/, '')}/${path}`
      sources.add(qualified)
      if (sources.size > 100_000) fail()
    }
  }
  visit(input, 0)
  return [...sources]
}

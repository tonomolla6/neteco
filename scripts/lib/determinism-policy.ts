/** Whether a raw Node network client is explicitly marked as a local harness. */
export function allowsLocalNetworkHarness(file: string, source: string): boolean {
  return (
    file === 'tests/integration/provider-recovery.test.ts' &&
    source.includes('determinism-audit: allow-local-network-harness')
  )
}

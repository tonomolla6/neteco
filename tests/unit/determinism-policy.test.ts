import { describe, expect, it } from 'vitest'
import { allowsLocalNetworkHarness } from '../../scripts/lib/determinism-policy'

const marker = '// determinism-audit: allow-local-network-harness -- controlled loopback fault injection'

describe('local network harness admission', () => {
  it('admits the explicitly reviewed harness only when it carries the marker', () => {
    expect(allowsLocalNetworkHarness('tests/integration/provider-recovery.test.ts', marker)).toBe(true)
    expect(allowsLocalNetworkHarness('tests/integration/provider-recovery.test.ts', 'import "node:http"')).toBe(false)
  })

  it.each([
    'tests/unit/unreviewed.test.ts',
    'tests/integration/provider-recovery.test.ts.backup',
    'tests/integration/../unit/provider-recovery.test.ts'
  ])('does not let an unreviewed file self-authorize with the marker: %s', (file) => {
    expect(allowsLocalNetworkHarness(file, marker)).toBe(false)
  })
})

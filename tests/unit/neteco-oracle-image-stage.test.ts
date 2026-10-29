import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve('scripts/lib/neteco-oracle-image-stage.sh')
const unit = resolve('infra/oracle-runner/devtono-neteco-image-stage.service')

describe('Oracle OCI staging checkout copies never perform staging (real Bash)', () => {
  it.each([[], ['--approve'], ['--root'], ['--stage=/tmp'], ['--image=untrusted/image']].map((args) => ({ args })))(
    'rejects checkout execution before identity or writes: $args',
    ({ args }) => {
      const result = spawnSync('/bin/bash', ['--noprofile', '--norc', script, ...args], {
        env: { PATH: '/usr/bin:/bin', NETECO_SKIP_PREFLIGHT: 'true', DOCKER_CONFIG: '/tmp', TMPDIR: '/tmp' },
        encoding: 'utf8',
        timeout: 1000
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr.trim()).toBe('neteco-oracle-image-stage: denied: untrusted_hook')
    }
  )

  it('cannot admit a stdin copy running as a different non-root UID', () => {
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-s'], {
      env: { PATH: '/usr/bin:/bin' },
      input: readFileSync(script, 'utf8'),
      encoding: 'utf8',
      timeout: 1000,
      ...(process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {})
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.trim()).toBe('neteco-oracle-image-stage: denied: untrusted_hook')
  })
})

describe('operator staging unit source contract (not positive runtime acceptance)', () => {
  const settings = () => {
    const result = new Map<string, string[]>()
    for (const line of readFileSync(unit, 'utf8').split('\n')) {
      const match = /^([A-Za-z]+)=(.*)$/.exec(line)
      if (match) result.set(match[1]!, [...(result.get(match[1]!) ?? []), match[2]!])
    }
    return result
  }

  it('runs only the installed script as UID980/GID979, bounded and without capabilities', () => {
    const config = settings()
    for (const [key, value] of Object.entries({
      Type: 'oneshot',
      User: '980',
      Group: '979',
      ExecStart: '/usr/bin/bash /usr/local/libexec/neteco-ci/image-stage.sh',
      ProtectSystem: 'strict',
      ProtectHome: 'yes',
      PrivateDevices: 'yes',
      PrivateTmp: 'yes',
      CapabilityBoundingSet: '',
      AmbientCapabilities: '',
      NoNewPrivileges: 'yes',
      CPUQuota: '100%',
      MemoryHigh: '512M',
      MemoryMax: '1G',
      MemorySwapMax: '128M',
      TasksMax: '128',
      IOWeight: '10',
      Nice: '10',
      TimeoutStartSec: '15min',
      Restart: 'no'
    }))
      expect(config.get(key), key).toEqual([value])
    expect(config.get('ReadWritePaths')).toEqual(['/var/lib/neteco-ci-runtime/stage'])
    expect(config.get('TemporaryFileSystem')).toEqual(['/run:ro /tmp:ro /var/tmp:ro'])
    expect(config.get('InaccessiblePaths')?.join(' ')).toContain('-/var/lib/neteco-ci')
  })

  it('uses only the isolated anchor/egress and operator DNS, never a host network fallback', () => {
    const config = settings()
    expect(config.get('PrivateNetwork')).toEqual(['yes'])
    expect(config.get('JoinsNamespaceOf')).toEqual(['devtono-neteco-network.service'])
    expect(config.get('Requires')?.join(' ')).toContain('devtono-neteco-egress.service')
    expect(config.get('BindReadOnlyPaths')).toEqual(['/etc/neteco-ci/resolv.conf:/etc/resolv.conf'])
    expect(config.has('WantedBy')).toBe(false)
  })
})

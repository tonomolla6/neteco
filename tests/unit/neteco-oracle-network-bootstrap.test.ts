import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(resolve(path), 'utf8')
const scripts = [
  ['anchor', 'scripts/lib/neteco-oracle-network-anchor.sh'],
  ['egress', 'scripts/lib/neteco-oracle-network-egress.sh']
] as const

describe('Oracle network bootstrap checkout copies fail closed (real Bash)', () => {
  // Never execute an installed operator hook or simulate successful admission.
  // These copies must reject before PID writes, mounts, or namespace changes.
  for (const [name, path] of scripts) {
    it(`${name} rejects unknown arguments before any bootstrap`, () => {
      const result = spawnSync('/bin/bash', ['--noprofile', '--norc', resolve(path), '--approve'], {
        env: { PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
        timeout: 1000
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr.trim()).toBe(`neteco-oracle-${name}: denied: unexpected_arguments`)
    })

    it(`${name} never admits its checkout copy`, () => {
      const result = spawnSync('/bin/bash', ['--noprofile', '--norc', resolve(path)], {
        env: { PATH: '/usr/bin:/bin', RUNTIME_DIRECTORY: '/tmp', NETECO_NETWORK_PID: '1' },
        encoding: 'utf8',
        timeout: 1000
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr.trim()).toMatch(new RegExp(`^neteco-oracle-${name}: denied: (identity|untrusted_hook)$`))
    })

    it(`${name} rejects non-root before opening operator paths`, () => {
      // stdin avoids granting nobody traversal through /root just to read the
      // test source; it does not replace any command or operator filesystem.
      const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-s'], {
        env: { PATH: '/usr/bin:/bin' },
        input: source(path),
        encoding: 'utf8',
        timeout: 1000,
        ...(process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {})
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr.trim()).toBe(`neteco-oracle-${name}: denied: identity`)
    })
  }
})

describe('Oracle network source unit contract (not installed-service acceptance)', () => {
  it('shares only a root-managed runtime PID directory from the anchor', () => {
    const unit = source('infra/oracle-runner/devtono-neteco-network.service')
    expect(unit).toContain('RuntimeDirectory=neteco-ci-network\n')
    expect(unit).toContain('RuntimeDirectoryMode=0700\n')
    expect(unit).toContain('ExecStart=/usr/bin/bash /usr/local/libexec/neteco-ci/network-anchor.sh\n')
    expect(unit).not.toMatch(/^TemporaryFileSystem=.*\/run(?::|\s|$)/m)
  })

  it('denies new AF_UNIX sockets and io_uring alternate socket creation in egress', () => {
    const unit = source('infra/oracle-runner/devtono-neteco-egress.service')
    expect(unit).toMatch(/^RestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK$/m)
    expect(unit).toMatch(/^SystemCallArchitectures=native$/m)
    expect(unit).toMatch(/^SystemCallFilter=~io_uring_setup io_uring_enter io_uring_register$/m)
    expect(unit).not.toContain('/run/systemd/private')
  })

  it('selects the anchor without querying the host systemd socket', () => {
    const helper = source('scripts/lib/neteco-oracle-network-egress.sh')
    expect(helper).not.toContain('/usr/bin/systemctl')
    expect(helper).toContain('/run/neteco-ci-network/anchor.pid')
    expect(helper).toContain('0::/system.slice/devtono-neteco-network.service')
    expect(helper).not.toContain('--enable-ipv6')
    expect(helper).not.toContain('--api-socket')
  })
})

import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

function privateIpv4(hostname: string) {
  const octets = hostname.split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  const [first, second] = octets as [number, number, number, number]
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  )
}

function privateIpv6(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === '::' || normalized === '::1') return true
  if (/^(?:fc|fd)/.test(normalized) || /^fe[89ab]/.test(normalized)) return true
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  return mapped ? privateIpv4(mapped[1]!) : false
}

interface OutboundUrlValidationOptions {
  allowQuery?: boolean
}

export function validatedOutboundHttpsUrl(
  value: string,
  allowedDomainSuffixes: readonly string[] = [],
  options: OutboundUrlValidationOptions = {}
) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Outbound provider URL must be absolute')
  }
  if (url.protocol !== 'https:') throw new Error('Outbound provider URL must use HTTPS')
  if (url.username || url.password || url.hash || (!options.allowQuery && url.search)) {
    throw new Error('Outbound provider URL cannot include credentials, query or fragment')
  }
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home') ||
    hostname.endsWith('.lan') ||
    (isIP(hostname) === 4 && privateIpv4(hostname)) ||
    (isIP(hostname) === 6 && privateIpv6(hostname))
  ) {
    throw new Error('Outbound provider URL cannot target a local or private network')
  }
  if (
    allowedDomainSuffixes.length > 0 &&
    !allowedDomainSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))
  ) {
    throw new Error('Outbound provider URL is outside the configured provider allowlist')
  }
  return url.toString().replace(/\/$/, '')
}

export type OutboundDnsResolver = (hostname: string) => Promise<readonly string[]>

async function systemResolver(hostname: string) {
  return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address)
}

export async function assertPublicOutboundTarget(
  value: string,
  allowedDomainSuffixes: readonly string[],
  resolver: OutboundDnsResolver = systemResolver
) {
  const safeUrl = validatedOutboundHttpsUrl(value, allowedDomainSuffixes, { allowQuery: true })
  const hostname = new URL(safeUrl).hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(hostname) ? [hostname] : await resolver(hostname)
  if (addresses.length === 0) throw new Error('Outbound provider hostname did not resolve')
  if (
    addresses.some(
      (address) =>
        (isIP(address) === 4 && privateIpv4(address)) || (isIP(address) === 6 && privateIpv6(address)) || !isIP(address)
    )
  ) {
    throw new Error('Outbound provider DNS resolved to a local, private or invalid address')
  }
  return safeUrl
}

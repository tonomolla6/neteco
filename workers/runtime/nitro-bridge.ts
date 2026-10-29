import canary from '../canary'

export interface NitroCloudflarePlatform {
  request: Request
  env: CloudflareEnv
}

export function isD1ApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/')
}

/**
 * Nitro's Cloudflare v2 adapter puts bindings in trusted event context; internal
 * SSR fetches inherit that context. Never read bindings from headers/global env.
 */
export async function dispatchNitroD1Request(
  request: Request,
  platform: NitroCloudflarePlatform | undefined
): Promise<Response | undefined> {
  const requestedUrl = new URL(request.url)
  if (!isD1ApiPath(requestedUrl.pathname)) return undefined
  if (!platform?.request || !platform.env?.DB) {
    return Response.json(
      { error: { code: 'service_unavailable' } },
      { status: 503, headers: { 'cache-control': 'no-store' } }
    )
  }
  // Host/X-Forwarded-Host from an internal H3 request are not origin authority.
  // Use the actual platform Request's origin and only the local path/query.
  const url = new URL(requestedUrl.pathname + requestedUrl.search, new URL(platform.request.url).origin)
  const forwarded = new Request(url, request)
  // SSR useRequestFetch omits proxy headers. Restore the edge-observed address
  // from trusted platform context, never an internal caller's supplied value.
  forwarded.headers.delete('cf-connecting-ip')
  const edgeAddress = platform.request.headers.get('cf-connecting-ip')
  if (edgeAddress) forwarded.headers.set('cf-connecting-ip', edgeAddress)
  const readOnly = (method: string) => method === 'GET' || method === 'HEAD'
  if (
    readOnly(request.method) &&
    readOnly(platform.request.method) &&
    !isD1ApiPath(new URL(platform.request.url).pathname) &&
    platform.request.headers.get('sec-fetch-mode') === 'navigate' &&
    platform.request.headers.get('sec-fetch-dest') === 'document'
  ) {
    // These headers describe the parent's browser document navigation, not
    // this server-side API read. Forwarding cross-site navigation metadata
    // would reject a legitimate Lax-cookie refresh after an external link.
    for (const name of [...forwarded.headers.keys()]) {
      if (name.startsWith('sec-fetch-')) forwarded.headers.delete(name)
    }
  }
  // Keep internal cookies and Origin unchanged: manufacturing an Origin here
  // would turn a failed CSRF check into an authorized mutation.
  return canary.fetch(forwarded, platform.env)
}

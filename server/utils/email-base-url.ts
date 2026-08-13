export function validatedEmailBaseUrl(value: string, environment: string | undefined) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('APP_BASE_URL must be an absolute HTTP(S) URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('APP_BASE_URL must use HTTP(S)')
  }
  if (environment === 'production' && url.protocol !== 'https:') {
    throw new Error('Production APP_BASE_URL must use HTTPS')
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('APP_BASE_URL must be a clean origin without credentials, path, query or fragment')
  }
  return url.origin
}

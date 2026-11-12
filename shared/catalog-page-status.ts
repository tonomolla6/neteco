/** A missing fetch result is an outage; only an explicit backend 404 confirms absence. */
export function catalogPageFailureStatus(error: unknown, data: unknown): 404 | 503 | null {
  if (error) {
    const failure = error as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } }
    const status = failure.statusCode ?? failure.status ?? failure.response?.status
    return status === 404 ? 404 : 503
  }
  return data === null || data === undefined ? 503 : null
}

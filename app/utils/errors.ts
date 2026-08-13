export function apiErrorMessage(error: unknown, fallback: string) {
  const candidate = error as { data?: { statusMessage?: string; message?: string } }
  return candidate.data?.statusMessage ?? candidate.data?.message ?? fallback
}

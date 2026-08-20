export interface WorkerBundleManifest {
  inputs?: Record<string, { imports?: Array<{ path: string }> }>
  outputs?: Record<string, { imports?: Array<{ path: string }> }>
}

const forbidden = [
  /(^|\/)postgres(?:\/|$)/,
  /(^|\/)ioredis(?:\/|$)/,
  /(^|\/)nodemailer(?:\/|$)/,
  /(^|\/)sharp(?:\/|$)/,
  /(^|\/)node:(?:fs|net)(?:\/|$)/,
  /\.(?:node|so)$/
]

export function auditWorkerManifest(manifest: WorkerBundleManifest) {
  const inputs = Object.entries(manifest.inputs ?? {})
  const outputs = Object.entries(manifest.outputs ?? {})
  const entries = [
    ...inputs.map(([path]) => path),
    ...outputs.map(([path]) => path),
    ...inputs.flatMap(([, value]) => value.imports?.map((entry) => entry.path) ?? []),
    ...outputs.flatMap(([, value]) => value.imports?.map((entry) => entry.path) ?? [])
  ]
  const violations = [...new Set(entries.filter((entry) => forbidden.some((pattern) => pattern.test(entry))))]
  return { inspected: entries.length, violations }
}

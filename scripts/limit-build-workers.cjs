// Nitro loads Terser through createRequire. ProcSubset=pid can hide CPU records;
// its default pool would then have no worker. Keep minification at 1–2 workers.
const Module = require('node:module')
const os = require('node:os')
const originalLoad = Module._load
const wrappers = new WeakMap()

Module._load = function (request, parent, isMain) {
  const loaded = Reflect.apply(originalLoad, this, [request, parent, isMain])
  if (request !== '@rollup/plugin-terser' || typeof loaded !== 'function') return loaded
  let wrapped = wrappers.get(loaded)
  if (!wrapped) {
    wrapped = function (options) {
      if (options !== undefined && (options === null || typeof options !== 'object')) {
        return Reflect.apply(loaded, this, arguments)
      }
      const requested = options?.maxWorkers
      const available =
        typeof requested === 'number' && Number.isFinite(requested) ? Math.floor(requested) : os.cpus().length
      return Reflect.apply(loaded, this, [{ ...options, maxWorkers: Math.max(1, Math.min(2, available)) }])
    }
    Object.assign(wrapped, loaded)
    if (loaded.default === loaded) wrapped.default = wrapped
    wrappers.set(loaded, wrapped)
  }
  return wrapped
}

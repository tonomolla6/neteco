import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CatalogFilePreflight from '../../app/components/CatalogFilePreflight.vue'
import '#app/nuxt-vitest-app-entry'

const { inspect, session } = vi.hoisted(() => ({ inspect: vi.fn(), session: vi.fn() }))
mockNuxtImport('useUserSession', () => session)
vi.mock('../../app/utils/catalog-import-file.client', () => ({ inspectCatalogImportFile: inspect }))
const ACTOR = '10000000-0000-4000-8000-000000000071'
const result = () => ({
  valid: true,
  issues: [],
  summary: { rows: 3, products: 1, variants: 2, assets: 3, documents: 1 },
  dataset: { products: [], variants: [], assets: [], media: [] }
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}
function file(name = 'catalogo.csv', content: ArrayBuffer = new Uint8Array([1, 2, 3]).buffer) {
  const value = new File([content], name)
  const read = vi.fn().mockResolvedValue(content)
  Object.defineProperty(value, 'arrayBuffer', { value: read })
  return { value, read }
}
async function select(wrapper: Awaited<ReturnType<typeof mountSuspended>>, value: File) {
  const input = wrapper.get('input[type=file]')
  Object.defineProperty(input.element, 'files', { configurable: true, value: [value] })
  await input.trigger('change')
  await flushPromises()
}
let actor: ReturnType<typeof identity>
function identity() {
  return {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref<Record<string, unknown> | null>({
      id: ACTOR,
      role: 'admin',
      emailVerified: true,
      mfaVerified: true
    })
  }
}
let wrappers: Awaited<ReturnType<typeof mountSuspended>>[] = []
async function mount(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(CatalogFilePreflight, {
    props: { runtime: 'cloudflare', available: true, ...props }
  })
  wrappers.push(wrapper)
  return wrapper
}
beforeEach(() => {
  vi.clearAllMocks()
  actor = identity()
  session.mockReturnValue(actor)
  inspect.mockResolvedValue(result())
})
afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount()
  wrappers = []
  vi.unstubAllGlobals()
})
describe('complete catalogue file preparation is local and deliberate', () => {
  it('has no file read, dynamic parser or network on mount and labels the local-only result', async () => {
    const request = vi.fn()
    vi.stubGlobal('$fetch', request)
    const wrapper = await mount()
    expect(inspect).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('71 columnas')
    expect(wrapper.text()).toContain('No modifica')
    expect(wrapper.get('input[type=file]').attributes('accept')).toBe('.csv,.xlsx')
  })
  it.each(['csv', 'xlsx'])(
    'reads %s only on selection and shows counts without claiming import approval',
    async (format) => {
      const request = vi.fn()
      vi.stubGlobal('$fetch', request)
      const wrapper = await mount()
      const source = file('catalogo.' + format)
      await select(wrapper, source.value)
      expect(inspect).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), format)
      expect(source.read).toHaveBeenCalledTimes(1)
      expect(wrapper.text()).toContain('Estructura local válida')
      expect(wrapper.get('[data-catalog-file-format]').attributes('data-catalog-file-format')).toBe(format)
      expect(wrapper.text()).toContain('No autoriza')
      expect(wrapper.text()).toContain('2 variantes')
      expect(request).not.toHaveBeenCalled()
    }
  )
  it.each(['cloudflare-invalid', 'node', '', undefined])('refuses runtime %s', async (runtime) => {
    const wrapper = await mount({ runtime })
    expect(wrapper.find('input[type=file]').exists()).toBe(false)
    expect(inspect).not.toHaveBeenCalled()
  })
  it('refuses unavailable functionality', async () => {
    const wrapper = await mount({ available: false })
    expect(wrapper.find('input[type=file]').exists()).toBe(false)
  })
  it.each(['ready', 'loggedIn', 'user', 'mfa', 'email', 'role', 'id'])('refuses unconfirmed actor %s', async (part) => {
    if (part === 'ready') actor.ready.value = false
    if (part === 'loggedIn') actor.loggedIn.value = false
    if (part === 'user') actor.user.value = null
    if (part === 'mfa') actor.user.value!.mfaVerified = false
    if (part === 'email') actor.user.value!.emailVerified = false
    if (part === 'role') actor.user.value!.role = 'customer'
    if (part === 'id') actor.user.value!.id = 'not-an-identity'
    const wrapper = await mount()
    expect(wrapper.find('input[type=file]').exists()).toBe(false)
    expect(inspect).not.toHaveBeenCalled()
  })
  it.each(['catalogo.xls', 'catalogo.xlsx.exe', 'catalogo', '.csv'])(
    'rejects unsupported file %s before reading',
    async (name) => {
      const wrapper = await mount()
      const source = file(name)
      await select(wrapper, source.value)
      expect(source.read).not.toHaveBeenCalled()
      expect(inspect).not.toHaveBeenCalled()
      expect(wrapper.get('[role=alert]').text()).toContain('CSV o XLSX')
    }
  )
  it.each([0, 20_000_001])('rejects file size %s before reading', async (size) => {
    const wrapper = await mount()
    const source = file()
    Object.defineProperty(source.value, 'size', { value: size })
    await select(wrapper, source.value)
    expect(source.read).not.toHaveBeenCalled()
    expect(inspect).not.toHaveBeenCalled()
  })
  it('explains the 20 MB file rejection and complete-product parts without reading or sending', async () => {
    const request = vi.fn()
    vi.stubGlobal('$fetch', request)
    const wrapper = await mount()
    const source = file('catalogo.xlsx')
    Object.defineProperty(source.value, 'size', { value: 20_000_001 })
    await select(wrapper, source.value)
    expect(wrapper.get('[role=alert]').text()).toContain('20 MB')
    expect(wrapper.get('[role=alert]').text()).toContain('comprimido')
    const help = wrapper.get('[data-import-limit-help]').text()
    expect(help).toContain('0 filas aceptadas')
    expect(help).toContain('productos completos')
    expect(help).toContain('variantes')
    expect(help).toContain('71 columnas')
    expect(help).toContain('importación parcial')
    expect(source.read).not.toHaveBeenCalled()
    expect(inspect).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
  it('explains an expanded XLSX rejection and clears the previous successful local result', async () => {
    const wrapper = await mount()
    await select(wrapper, file().value)
    inspect.mockResolvedValue({
      ...result(),
      valid: false,
      summary: { rows: 0, products: 0, variants: 0, assets: 0, documents: 0 },
      issues: [{ code: 'catalog_file_too_large', message: 'El contenido descomprimido del XLSX supera los 100 MB.' }]
    })
    await select(wrapper, file('catalogo.xlsx').value)
    expect(wrapper.text()).toContain('descomprimido')
    expect(wrapper.text()).toContain('100 MB')
    expect(wrapper.get('[data-import-limit-help]').text()).toContain('0 filas aceptadas')
    expect(wrapper.text()).not.toContain('Estructura local válida')
    expect(wrapper.text()).not.toContain('2 variantes')
  })
  it('shows validation issues without rendering imported HTML or the filename as HTML', async () => {
    inspect.mockResolvedValue({
      ...result(),
      valid: false,
      issues: [{ row: 3, field: 'sku', code: 'field.invalid', message: '<img src=x onerror=alert(1)>' }]
    })
    const wrapper = await mount()
    await select(wrapper, file('catalogo<img>.csv').value)
    expect(wrapper.text()).toContain('Fila 3')
    expect(wrapper.text()).toContain('sku')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Estructura local válida')
  })
  it('bounds the rendered issue list and keeps the total visible', async () => {
    inspect.mockResolvedValue({
      ...result(),
      valid: false,
      issues: Array.from({ length: 250 }, () => ({ code: 'field.invalid', message: 'Dato inválido' }))
    })
    const wrapper = await mount()
    await select(wrapper, file().value)
    expect(wrapper.findAll('[data-import-issue]')).toHaveLength(100)
    expect(wrapper.text()).toContain('250 incidencias')
  })
  it('sanitizes parser failures and permits a new deliberate selection, not an automatic retry', async () => {
    inspect.mockRejectedValueOnce(new Error('secret sql/path/provider'))
    const wrapper = await mount()
    await select(wrapper, file().value)
    expect(wrapper.get('[role=alert]').text()).toContain('No se ha podido validar')
    expect(wrapper.text()).not.toContain('secret')
    expect(inspect).toHaveBeenCalledTimes(1)
    await select(wrapper, file('nuevo.csv').value)
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('Estructura local válida')
    expect(wrapper.get('[data-catalog-file-format]').attributes('data-catalog-file-format')).toBe('csv')
  })
  it('does not publish an old file result over the newly selected file', async () => {
    const old = deferred<ReturnType<typeof result>>()
    inspect.mockReturnValueOnce(old.promise)
    const wrapper = await mount()
    await select(wrapper, file('viejo.csv').value)
    await select(wrapper, file('nuevo.csv').value)
    old.resolve({ ...result(), summary: { ...result().summary, products: 99 } })
    await flushPromises()
    expect(wrapper.text()).not.toContain('99 productos')
    expect(wrapper.text()).toContain('1 producto')
  })
  it('drops result and file-read continuation after actor change', async () => {
    const read = deferred<ArrayBuffer>()
    const source = file()
    source.read.mockReturnValueOnce(read.promise)
    const wrapper = await mount()
    await select(wrapper, source.value)
    actor.user.value!.id = '10000000-0000-4000-8000-000000000072'
    await flushPromises()
    read.resolve(new Uint8Array([1, 2, 3]).buffer)
    await flushPromises()
    expect(inspect).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('Estructura local válida')
  })
  it('clears prior validation when capability or MFA is lost', async () => {
    const wrapper = await mount()
    await select(wrapper, file().value)
    actor.user.value!.mfaVerified = false
    await flushPromises()
    expect(wrapper.find('input[type=file]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Estructura local válida')
    await wrapper.setProps({ available: false })
    expect(wrapper.find('input[type=file]').exists()).toBe(false)
  })
  it('drops delayed parser completion after unmount', async () => {
    const pending = deferred<ReturnType<typeof result>>()
    inspect.mockReturnValueOnce(pending.promise)
    const wrapper = await mount()
    await select(wrapper, file().value)
    wrapper.unmount()
    pending.resolve(result())
    await flushPromises()
    expect(inspect).toHaveBeenCalledTimes(1)
  })
  it('clears stale output on in-place availability changes', async () => {
    const props = reactive({ runtime: 'cloudflare', available: true })
    const wrapper = await mount(props)
    await select(wrapper, file().value)
    await wrapper.setProps({ runtime: 'node' })
    expect(wrapper.text()).not.toContain('Estructura local válida')
  })
})

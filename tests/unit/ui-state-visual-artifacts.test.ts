import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { captureUiStateMarkup } from '../fixtures/ui-state-visual-artifacts'

const fs = vi.hoisted(() => ({
  files: new Map<string, string>(),
  directories: new Set<string>(),
  symlinks: new Set<string>(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  lstat: vi.fn(),
  realpath: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn()
}))
vi.mock('node:fs/promises', () => ({
  readFile: fs.readFile,
  readdir: fs.readdir,
  mkdir: fs.mkdir,
  writeFile: fs.writeFile,
  lstat: fs.lstat,
  realpath: fs.realpath,
  rename: fs.rename,
  unlink: fs.unlink
}))
const output = resolve('test-results/ui013-components'),
  css = resolve('.output-cloudflare/public/_nuxt'),
  nodeCss = resolve('.output/public/_nuxt')
const id = 'admin-orders-dense',
  htmlPath = resolve(output, id + '.html'),
  metaPath = resolve(output, id + '.json')
const markup = '<section><h1>Pedidos · banco de preparación</h1><p>Fixture sintético</p></section>'
const missing = () => Object.assign(new Error('Synthetic missing file'), { code: 'ENOENT' })
beforeEach(() => {
  vi.stubEnv('NETECO_UI_STATE_CAPTURE_DIR', 'test-results/ui013-components')
  fs.files.clear()
  fs.directories.clear()
  fs.symlinks.clear()
  for (const value of Object.values(fs)) if (vi.isMockFunction(value)) value.mockReset()
  for (const path of [process.cwd(), resolve('test-results'), css, nodeCss]) fs.directories.add(path)
  fs.files.set(resolve(css, 'app.css'), ':root{--profile:cloudflare}')
  fs.files.set(resolve(nodeCss, 'app.css'), ':root{--profile:node}')
  fs.readFile.mockImplementation(async (path: string) => {
    const data = fs.files.get(resolve(path))
    if (data === undefined) throw missing()
    return data
  })
  fs.readdir.mockImplementation(async (path: string) => {
    if (!fs.directories.has(resolve(path))) throw missing()
    return [...fs.files.keys()]
      .filter((file) => dirname(file) === resolve(path))
      .map((file) => file.slice(file.lastIndexOf('/') + 1))
  })
  fs.mkdir.mockImplementation(async (path: string, options?: { recursive?: boolean }) => {
    if (fs.directories.has(resolve(path)) && !options?.recursive)
      throw Object.assign(Error('Synthetic exists'), { code: 'EEXIST' })
    fs.directories.add(resolve(path))
  })
  fs.writeFile.mockImplementation(async (path: string, value: string, options?: { flag?: string }) => {
    const key = resolve(path)
    if (options?.flag === 'wx' && fs.files.has(key)) throw Object.assign(Error('Synthetic exists'), { code: 'EEXIST' })
    fs.files.set(key, value)
  })
  fs.lstat.mockImplementation(async (path: string) => {
    const key = resolve(path)
    if (!fs.symlinks.has(key) && !fs.directories.has(key) && !fs.files.has(key)) throw missing()
    return {
      isSymbolicLink: () => fs.symlinks.has(key),
      isDirectory: () => fs.directories.has(key),
      isFile: () => fs.files.has(key),
      nlink: 1,
      size: Buffer.byteLength(fs.files.get(key) ?? '')
    }
  })
  fs.realpath.mockImplementation(async (path: string) => resolve(path))
  fs.rename.mockImplementation(async (from: string, to: string) => {
    const value = fs.files.get(resolve(from))
    if (value === undefined) throw missing()
    fs.files.set(resolve(to), value)
    fs.files.delete(resolve(from))
  })
  fs.unlink.mockImplementation(async (path: string) => {
    fs.files.delete(resolve(path))
  })
})
afterEach(() => vi.unstubAllEnvs())
const capture = () => captureUiStateMarkup(id, 'AdminOrderWorkbench', markup)
it('does not read files or create artifacts when capture is not explicitly enabled', async () => {
  vi.stubEnv('NETECO_UI_STATE_CAPTURE_DIR', '')
  await capture()
  expect(fs.readFile).not.toHaveBeenCalled()
  expect(fs.readdir).not.toHaveBeenCalled()
  expect(fs.mkdir).not.toHaveBeenCalled()
  expect(fs.writeFile).not.toHaveBeenCalled()
})
it('captures the selected real markup with Cloudflare CSS and exact content hashes, never Node CSS', async () => {
  await capture()
  const html = fs.files.get(htmlPath)!,
    metadata = JSON.parse(fs.files.get(metaPath)!)
  expect(html).toContain(markup)
  expect(html).toContain('--profile:cloudflare')
  expect(html).not.toContain('--profile:node')
  expect(metadata.cssSource).toBe('.output-cloudflare/public/_nuxt')
  expect(metadata.cssHash).toBe(createHash('sha256').update(':root{--profile:cloudflare}').digest('hex'))
  expect(metadata.htmlHash).toBe(createHash('sha256').update(html).digest('hex'))
})
it('fails without Cloudflare CSS even when another profile has CSS available', async () => {
  fs.directories.delete(css)
  await expect(capture()).rejects.toThrow()
  expect(fs.writeFile).not.toHaveBeenCalled()
})
it('rejects a non-owned output path before making any file writes', async () => {
  vi.stubEnv('NETECO_UI_STATE_CAPTURE_DIR', 'test-results/not-owned')
  await expect(capture()).rejects.toThrow()
  expect(fs.mkdir).not.toHaveBeenCalled()
  expect(fs.writeFile).not.toHaveBeenCalled()
})
it.each(['directory', 'target'] as const)('does not follow an existing %s symlink', async (mode) => {
  fs.directories.add(output)
  fs.symlinks.add(mode === 'directory' ? output : htmlPath)
  await expect(capture()).rejects.toThrow()
  expect(fs.writeFile).not.toHaveBeenCalled()
})
it('preserves an existing foreign artifact instead of overwriting it', async () => {
  fs.directories.add(output)
  fs.files.set(htmlPath, 'unrelated evidence')
  await expect(capture()).rejects.toThrow()
  expect(fs.files.get(htmlPath)).toBe('unrelated evidence')
  expect(fs.writeFile).not.toHaveBeenCalled()
})
it('can regenerate only its own matching previously captured pair', async () => {
  await capture()
  const original = fs.files.get(htmlPath)
  await captureUiStateMarkup(id, 'AdminOrderWorkbench', markup.replace('Fixture sintético', 'Fixture actualizado'))
  expect(fs.files.get(htmlPath)).not.toBe(original)
  expect(fs.files.get(htmlPath)).toContain('Fixture actualizado')
  const metadata = JSON.parse(fs.files.get(metaPath)!)
  expect(metadata.htmlHash).toBe(createHash('sha256').update(fs.files.get(htmlPath)!).digest('hex'))
})

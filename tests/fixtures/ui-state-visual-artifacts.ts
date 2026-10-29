import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile, lstat, realpath, rename, unlink } from 'node:fs/promises'
import { resolve, join, relative, dirname } from 'node:path'

const owner = 'neteco-ui013-components-v1'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
async function optionalStat(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
async function realDirectory(path: string) {
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || !stat.isDirectory() || (await realpath(path)) !== path)
    throw Error('Real artifact directory required')
}
async function ownedPair(htmlPath: string, metadataPath: string, id: string, component: string) {
  const [htmlStat, metadataStat] = await Promise.all([optionalStat(htmlPath), optionalStat(metadataPath)])
  if (!htmlStat && !metadataStat) return
  if (
    !htmlStat ||
    !metadataStat ||
    [htmlStat, metadataStat].some((stat) => stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) ||
    htmlStat.size > 5 * 1024 * 1024 ||
    metadataStat.size > 4096
  )
    throw Error('Existing artifact is not an owned pair')
  const html = await readFile(htmlPath, 'utf8'),
    metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>
  if (
    metadata.owner !== owner ||
    metadata.id !== id ||
    metadata.component !== component ||
    metadata.kind !== 'static_real_component_mount' ||
    metadata.cssSource !== '.output-cloudflare/public/_nuxt' ||
    metadata.htmlHash !== hash(html)
  )
    throw Error('Foreign or modified artifact preserved')
}

/** Opt-in bounded private artifacts from actual component mounts. No app route,
 * fake login, HTML demo, screenshot, baseline or external request is created. */
export async function captureUiStateMarkup(id: string, component: string, markup: string) {
  const requested = process.env.NETECO_UI_STATE_CAPTURE_DIR
  if (!requested) return
  if (!/^(admin|customer)-orders-(dense|empty|loading|error|stale|permission-denied)$/.test(id))
    throw Error('Unknown capture case')
  if (
    component !== (id.startsWith('admin-') ? 'AdminOrderWorkbench' : 'CustomerOrdersPage') ||
    !markup.includes('<h1') ||
    Buffer.byteLength(markup) > 512 * 1024
  )
    throw Error('Non-component capture rejected')
  const directory = resolve(requested),
    allowed = resolve('test-results/ui013-components')
  if (directory !== allowed) throw Error('Only the owned UI013 capture directory is allowed')
  await realDirectory(dirname(directory))
  if (!(await optionalStat(directory))) await mkdir(directory)
  await realDirectory(directory)
  const htmlPath = join(directory, id + '.html'),
    metadataPath = join(directory, id + '.json')
  await ownedPair(htmlPath, metadataPath, id, component)
  const assetRoot = resolve('.output-cloudflare/public/_nuxt')
  await realDirectory(assetRoot)
  const names = (await readdir(assetRoot)).filter((name) => name.endsWith('.css')).sort()
  if (!names.length || names.length > 100) throw Error('Existing compiled CSS required')
  let css = ''
  let cssBytes = 0
  for (const name of names) {
    const stat = await lstat(join(assetRoot, name))
    cssBytes += stat.size
    if (stat.isSymbolicLink() || !stat.isFile() || cssBytes > 4 * 1024 * 1024)
      throw Error('CSS capture budget or source invalid')
    css += await readFile(join(assetRoot, name), 'utf8')
    if (Buffer.byteLength(css) > 4 * 1024 * 1024) throw Error('CSS capture budget exceeded')
  }
  if (/<script\b/i.test(markup) || /<\/style/i.test(css)) throw Error('Active markup rejected')
  const html =
    '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src \'none\'"><style>' +
    css +
    '</style></head><body>' +
    markup +
    '</body></html>'
  const metadata = JSON.stringify({
    owner,
    id,
    component,
    kind: 'static_real_component_mount',
    cssSource: relative(process.cwd(), assetRoot),
    cssHash: hash(css),
    htmlHash: hash(html)
  })
  // Exclusive own staging files plus rename never follow a target symlink.
  // Refuse to replace anything except an unchanged previous owned pair.
  const suffix = '.ui013-' + randomUUID(),
    htmlTemporary = htmlPath + suffix,
    metadataTemporary = metadataPath + suffix
  const created: string[] = []
  try {
    await writeFile(htmlTemporary, html, { flag: 'wx' })
    created.push(htmlTemporary)
    await writeFile(metadataTemporary, metadata, { flag: 'wx' })
    created.push(metadataTemporary)
    await ownedPair(htmlPath, metadataPath, id, component)
    await rename(htmlTemporary, htmlPath)
    await rename(metadataTemporary, metadataPath)
  } finally {
    for (const path of created)
      await unlink(path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
  }
}

import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import ts from 'typescript'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'

let runtime: Miniflare | undefined
let dispatch: (request: Request) => Promise<Response>
const outbound = vi.fn(() => {
  throw new Error('outbound_forbidden')
})
const origin = 'https://navigation-transport.neteco.test'

beforeAll(async () => {
  const source = await readFile(new URL('../../scripts/audit-cloudflare-shop.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('audit-cloudflare-shop.ts', source, ts.ScriptTarget.ESNext, true)
  let declaration: ts.VariableStatement | undefined
  function visit(node: ts.Node) {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (value) => ts.isIdentifier(value.name) && value.name.text === 'nativeDispatch'
      )
    )
      declaration = node
    ts.forEachChild(node, visit)
  }
  visit(ast)
  expect(declaration, 'actual nativeDispatch declaration required').toBeDefined()
  const compiled = ts.transpileModule(declaration!.getText(ast), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'native-navigation-transport-receiver',
      modules: true,
      compatibilityDate: '2026-08-15',
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      outboundService: outbound,
      script: `export default {fetch(request){
      return Response.json({
        mode:request.headers.get('sec-fetch-mode'),
        dest:request.headers.get('sec-fetch-dest'),
        site:request.headers.get('sec-fetch-site'),
        origin:request.headers.get('origin'),
        mfMode:request.headers.get('MF-Sec-Fetch-Mode')
      });
    }};`
    })
  )
  // Execute only the actual declaration, never the audit main or a copy of
  // its forwarding logic. The receiver observes Undici + Miniflare ingress.
  dispatch = new Function('runtime', `${compiled.outputText}\nreturn nativeDispatch;`)(runtime)
}, 30000)

afterAll(async () => {
  await runtime?.dispose()
  expect(outbound).not.toHaveBeenCalled()
})

it('preserves real document navigation mode, destination and site through nativeDispatch', async () => {
  const response = await dispatch(
    new Request(origin + '/admin/inventario', {
      headers: {
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        'sec-fetch-site': 'cross-site'
      }
    })
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    mode: 'navigate',
    dest: 'document',
    site: 'cross-site',
    origin: null,
    mfMode: null
  })
})

it('preserves cross-site API metadata and never manufactures an Origin', async () => {
  for (const requestOrigin of [undefined, 'https://outside.neteco.test']) {
    const response = await dispatch(
      new Request(origin + '/api/_auth/session', {
        headers: {
          'sec-fetch-mode': 'cors',
          'sec-fetch-dest': 'empty',
          'sec-fetch-site': 'cross-site',
          ...(requestOrigin ? { origin: requestOrigin } : {})
        }
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      mode: 'cors',
      dest: 'empty',
      site: 'cross-site',
      origin: requestOrigin ?? null,
      mfMode: null
    })
  }
})

it('does not let an injected MF header override the original browser fetch mode', async () => {
  const response = await dispatch(
    new Request(origin + '/api/_auth/session', {
      headers: {
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'sec-fetch-site': 'cross-site',
        'MF-Sec-Fetch-Mode': 'navigate'
      }
    })
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    mode: 'cors',
    dest: 'empty',
    site: 'cross-site',
    origin: null,
    mfMode: null
  })
})

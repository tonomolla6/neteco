import { createServer } from 'node:http'

const requests: Array<{ method: string; path: string; token: string | undefined }> = []
const server = createServer((incoming, response) => {
  response.setHeader('content-type', 'application/json')
  if (incoming.url === '/__requests') {
    response.writeHead(200).end(JSON.stringify(requests))
    return
  }
  const token = Array.isArray(incoming.headers.token) ? incoming.headers.token[0] : incoming.headers.token
  requests.push({ method: incoming.method ?? '', path: incoming.url ?? '', token })
  if (token !== 'integration-beply-token') {
    response.writeHead(401).end('{"error":"unauthorized"}')
  } else if (incoming.method === 'POST' && incoming.url === '/api/3/clientes') {
    response.writeHead(201).end('{"ok":true}')
  } else if (incoming.method === 'GET' && incoming.url?.startsWith('/api/3/contactos?')) {
    response.writeHead(200).end('[]')
  } else if (incoming.method === 'POST' && incoming.url === '/api/3/contactos') {
    response.writeHead(201).end('{"idcontacto":1}')
  } else if (incoming.method === 'POST' && incoming.url === '/api/3/crearFacturaCliente') {
    response.writeHead(409).end('{"error":"duplicate_or_unknown"}')
  } else {
    response.writeHead(404).end('{"error":"not_found"}')
  }
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Beply test server did not bind a TCP port')
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`)
})

process.once('SIGTERM', () => server.close(() => process.exit(0)))

const errors = {
  '400': { description: 'Cabecera de idempotencia inválida' },
  '401': { description: 'Credencial ausente, inválida o revocada' },
  '403': { description: 'Scope insuficiente' },
  '404': { description: 'Ruta o entorno desconocido' },
  '405': { description: 'Método no admitido' },
  '409': { description: 'Clave de idempotencia usada con otro contenido' },
  '422': { description: 'Contenido inválido' },
  '429': { description: 'Cuota diaria agotada' },
  '503': { description: 'Servicio no disponible' }
} as const
const security = [{ bearerAuth: [] }]
const page = [
  { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 1000, default: 1 } }
]
const item = {
  type: 'object',
  required: ['id', 'reference', 'version', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    reference: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' },
    version: { type: 'integer', enum: [1] },
    createdAt: { type: 'string', format: 'date-time' }
  }
}
export const b2bPublicOpenApi = {
  openapi: '3.0.3',
  info: {
    title: 'Neteco B2B API',
    version: '1.0.0',
    description:
      'Registro aislado de referencias de integración; no crea pedidos. Los scopes son requests.read y requests.write. Sandbox usa datos sintéticos y se reinicia a las 00:00 UTC. Cada clave tiene cuota diaria por UTC.'
  },
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
  paths: {
    '/api/b2b/v1/requests': {
      get: {
        summary: 'Consultar hasta 100 referencias propias',
        security,
        parameters: page,
        responses: {
          '200': {
            description: 'Referencias',
            content: {
              'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: item } } } }
            }
          },
          ...errors
        }
      },
      post: {
        summary: 'Registrar referencia idempotente',
        security,
        parameters: [
          {
            in: 'header',
            name: 'Idempotency-Key',
            required: true,
            schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' }
          }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['reference'],
                properties: {
                  reference: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 100,
                    pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': { description: 'Repetición del comando', content: { 'application/json': { schema: item } } },
          '201': { description: 'Referencia creada', content: { 'application/json': { schema: item } } },
          ...errors
        }
      }
    },
    '/api/b2b/v1/catalog': {
      get: {
        summary: 'Catálogo publicado o sintético en sandbox',
        security,
        parameters: page,
        responses: { '200': { description: 'Hasta 50 productos y precios públicos; no tarifas negociadas' }, ...errors }
      }
    },
    '/api/b2b/v1/sandbox/catalog': {
      get: {
        summary: 'Catálogo sintético, solo sandbox',
        security,
        parameters: page,
        responses: { '200': { description: 'Productos sintéticos' }, ...errors }
      }
    }
  }
} as const

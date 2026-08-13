export const REDSYS_OFFICIAL_CONTRACT = {
  sources: {
    signature: 'https://pagosonline.redsys.es/desarrolladores-inicio/documentacion-operativa/firmar-una-operacion/',
    responseCodes:
      'https://pagosonline.redsys.es/desarrolladores-inicio/integrate-con-nosotros/parametros-de-entrada-y-salida/',
    sandbox:
      'https://pagosonline.redsys.es/desarrolladores-inicio/integrate-con-nosotros/tarjetas-y-entornos-de-prueba/'
  },
  accessedAt: '2026-08-13',
  sandbox: {
    merchantCode: '999008881',
    terminal: '1',
    secretKey: 'sq7HjrUOBfKmC576ILgskD5srU870gJ7',
    currency: '978'
  },
  signature: {
    order: '1234567890',
    merchantParameters:
      'eyJEU19NRVJDSEFOVF9BTU9VTlQiOiI5OTkiLCJEU19NRVJDSEFOVF9PUkRFUiI6IjEyMzQ1Njc4OTAiLCJEU19NRVJDSEFOVF9NRVJDSEFOVENPREUiOiI5OTkwMDg4ODEiLCJEU19NRVJDSEFOVF9DVVJSRU5DWSI6Ijk3OCIsIkRTX01FUkNIQU5UX1RSQU5TQUNUSU9OVFlQRSI6IjAiLCJEU19NRVJDSEFOVF9URVJNSU5BTCI6IjEiLCJEU19NRVJDSEFOVF9NRVJDSEFOVFVSTCI6Imh0dHA6XC9cL3d3dy5wcnVlYmEuY29tXC91cmxOb3RpZmljYWNpb24ucGhwIiwiRFNfTUVSQ0hBTlRfVVJMT0siOiJodHRwOlwvXC93d3cucHJ1ZWJhLmNvbVwvdXJsT0sucGhwIiwiRFNfTUVSQ0hBTlRfVVJMS08iOiJodHRwOlwvXC93d3cucHJ1ZWJhLmNvbVwvdXJsS08ucGhwIn0',
    operationKeyBase64: 'RWt3/IPTzYRMXsQtkiGRKg==',
    signature: 'Vjo02eSWq249IeZZp3R-ArFnGLhKY0OuzDDlx1BuVtZDC2yhczA7_11uZhsYzLZBCMFAz8u8uzGDX3AErHKmmw'
  },
  responseCases: [
    ['0000', 'captured'],
    ['0099', 'captured'],
    ['9915', 'cancelled'],
    ['9997', 'pending'],
    ['9998', 'pending'],
    ['9999', 'pending'],
    ['0101', 'failed']
  ]
} as const

/** Business scope approved by the user on 2026-09-08. Not completion evidence. */
export const discardedRequirements = new Set([
  'CHK-021',
  'CUS-020',
  'CUS-021',
  'CUS-025',
  'CUS-029',
  'COM-018',
  'MKT-034'
])

export const scopedRequirements: Record<string, { requirement: string; acceptance: string }> = {
  'CUS-002': {
    requirement: 'Modelo de cliente particular y empresa sin jerarquías multisede.',
    acceptance:
      'Cliente, empresa, NIF, razón social, nombre comercial y contacto tienen identificadores y restricciones; sin sedes ni compradores/aprobadores delegados.'
  },
  'PDP-020': {
    requirement: 'Disponibilidad y recogida en el único almacén.',
    acceptance:
      'Disponibilidad útil y autorizada, reserva consistente y recogida cuando esté habilitada; sin selector multi-almacén.'
  },
  'INV-015': {
    requirement: 'Ubicaciones de picking en un único almacén.',
    acceptance:
      'Recepción, preparación, reserva y disponibilidad consistentes en el único almacén; sin transferencias entre almacenes.'
  },
  'PRI-019': {
    requirement: 'Catálogos/tarifas por cliente o empresa.',
    acceptance:
      'Precio contractual prevalece con vigencia, versión y aprobación interna de NETECO; sin tarifas por sede.'
  },
  'CUS-022': {
    requirement: 'Catálogo/tarifa por cliente o empresa.',
    acceptance: 'Asignación versionada con vigencia y aislamiento de precios contractuales; sin jerarquías por sede.'
  },
  'CUS-024': {
    requirement: 'Referencia interna u orden de compra del cliente.',
    acceptance:
      'Referencia opcional visible en pedido/documentos según mapeo; sin centros de coste, presupuestos departamentales ni circuitos de aprobación del comprador.'
  },
  'SHP-025': {
    requirement: 'Condiciones de envío por cliente o empresa.',
    acceptance: 'Métodos, cuenta de portes y recogida tras autenticación sin fuga de datos; sin condiciones por sede.'
  },
  'DAT-020': {
    requirement: 'Métricas de venta a empresas.',
    acceptance:
      'Activación, conversión, recurrencia y condiciones comerciales reales; sin métricas de sedes, aprobadores ni presupuestos departamentales.'
  },
  'MKT-031': {
    requirement: 'Casos de éxito autorizados y verificables.',
    acceptance:
      'Participantes autorizan publicación y resultados verificables; sin comunidad, perfiles sociales ni comentarios comunitarios.'
  },
  'MKT-035': {
    requirement: 'Campañas por cliente, empresa o sector.',
    acceptance:
      'Segmentación, tarifas y consentimientos correctos y reporting; sin targeting por sede o jerarquía de compradores.'
  },
  'TST-042': {
    requirement: 'Tests de aislamiento entre particulares y empresas.',
    acceptance:
      'Datos, pedidos, tarifas y condiciones comerciales no cruzan cuentas bajo concurrencia; sin escenarios multisede, roles de compradores ni aprobación departamental.'
  }
}

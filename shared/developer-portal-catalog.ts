/** Static pointers, not an inventory of live health or assigned on-call staff. */
export const developerServices = [
  {
    id: 'catalog',
    name: 'Catálogo',
    owner: 'Catálogo / Plataforma',
    ownerStatus: 'pending_confirmation',
    documentation: 'docs/operations/catalog-releases.md',
    runbook: 'docs/operations/incident-runbooks.md',
    metricDescription: 'Latencia de la API de catálogo',
    metricStatus: 'not_connected'
  },
  {
    id: 'checkout',
    name: 'Checkout',
    owner: 'Operaciones / Plataforma',
    ownerStatus: 'pending_confirmation',
    documentation: 'docs/operations/support-and-slo.md',
    runbook: 'docs/operations/incident-runbooks.md',
    metricDescription: 'Éxito de creación de pedido',
    metricStatus: 'not_connected'
  },
  {
    id: 'operations',
    name: 'Operaciones y continuidad',
    owner: 'Operaciones / Plataforma',
    ownerStatus: 'pending_confirmation',
    documentation: 'docs/operations/support-and-slo.md',
    runbook: 'docs/operations/incident-runbooks.md',
    metricDescription: 'Edad de trabajos críticos',
    metricStatus: 'not_connected'
  }
] as const

export const developerTemplates = [
  {
    id: 'change',
    title: 'Cambio de servicio',
    steps: [
      'Identificar responsable, permisos y comportamiento afectado.',
      'Escribir una prueba que falle, implementar el cambio y ejecutar las comprobaciones pertinentes.',
      'Revisar runbook y preparar CI en Oracle antes de promover.'
    ]
  },
  {
    id: 'incident',
    title: 'Incidente',
    steps: [
      'Asignar comandante y escriba y registrar severidad y cronología.',
      'Seguir el runbook aplicable y conservar evidencia sin secretos ni datos personales.',
      'Conciliar y registrar acciones con responsables antes de cerrar.'
    ]
  }
] as const

export function filterDeveloperServices(query: string) {
  const normalized = query.trim().toLocaleLowerCase('es')
  return developerServices.filter((service) =>
    [service.id, service.name, service.owner].some((value) => value.toLocaleLowerCase('es').includes(normalized))
  )
}

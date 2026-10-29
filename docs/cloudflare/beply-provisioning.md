# Beply: configuración de Neteco

Decisiones del usuario confirmadas el 2026-09-08:

- `https://neteco.beply.es` es **producción**.
- Crear una serie dedicada a las ventas de la tienda. Validarla y conservarla;
  el usuario ha confirmado expresamente que la serie no debe borrarse.
- Validar inmediatamente cada recurso temporal creado para probar la integración
  y borrarlo después. Esto solo cubre recursos propios de esas pruebas, nunca
  documentos o configuración preexistentes.
- Antes de crear un recurso temporal, comprobar que su API permite revertirlo.
  Si emitir un documento fiscal causa efectos que el borrado no revierte, usar
  pruebas locales hasta resolver esa condición.

Estado: serie todavía no creada; código pendiente de comprobar contra las series
existentes y las restricciones de la API. No se han realizado llamadas a Beply
en esta intervención.

El adaptador actual recibe `invoiceSeries` y `correctiveSeries` por configuración.
La serie de ventas deberá enlazarse a `invoiceSeries`; una serie rectificativa
requiere su propia configuración. Las pruebas automáticas locales no deben cargar
credenciales de producción.

Preparación de la vertical D1 (2026-09-08):

- BEP-004 exige confirmar el evento outbox en el mismo batch que el pago.
  El hecho técnico «pago capturado» no equivale a autorización fiscal de emisión:
  BEP-002 sigue pendiente de decisión documentada y no se debe suplir con código.
- `server/integrations/invoice-provider.ts` ya define el contrato de proveedor,
  pero no un método de búsqueda/reconciliación por clave externa. Debe resolverse
  antes de reintentar una emisión cuyo resultado remoto sea desconocido.
- `scripts/invoice-worker.ts` depende de PostgreSQL y APIs Node; no es un consumidor
  Worker/D1 reutilizable directamente. Sus leases y estados sirven de referencia,
  no de evidencia de que la vertical Cloudflare esté implementada.
- La cola nueva deberá conservar los hechos del pago sin emitir remotamente hasta
  disponer de política fiscal, mapeos y contrato de reconciliación verificados.

Implementado localmente: `0009_fiscal_outbox.sql` conserva un evento inmutable
`invoice.evaluate.requested` por pedido al confirmar el pago y crea su estado de
entrega `blocked_policy`. Los triggers participan en el batch de finalización:
si falla el evento, la transición a pagado se revierte; la recuperación del pago
puede completarlo sin otro descuento de inventario. La migración recoge también
los pedidos ya pagados. No incluye PII ni credenciales en el evento.

`workers/catalog/fiscal-outbox.ts` implementa el publicador de transporte:
lotes limitados, concesiones de 60 segundos con token, recuperación de concesiones
caducadas, reintentos con espera creciente y revisión manual tras diez intentos.
Solo envía tipo, versión e ID del evento; no envía PII. Un envío confirmado por la
cola pero no por D1 puede repetirse con el mismo ID (entrega al menos una vez).
Las pruebas locales cubren bloqueo por política, fallo de transporte, publicadores
concurrentes y un publicador antiguo que pierde su concesión.

El handler programado del canary conecta el publicador al binding `ASYNC_JOBS`.
Su handler Queue reconoce estos eventos antes de procesar mensajes de inventario.
`0010_fiscal_evaluation_inbox.sql` guarda una única recepción por evento/pedido;
el receptor consulta el evento autoritativo en D1, rechaza campos adicionales y
solo confirma la entrega tras persistir o encontrar la recepción previa. Fallos
de D1 y eventos todavía no publicables solicitan reintento. La solicitud recibida
permanece `blocked_policy`, no se presenta como factura emitida.

La auditoría aislada de checkout ahora publica mediante el binding Queue local
de workerd y ejecuta el receptor de producción: espera la finalización de doce
entregas duplicadas y exige una sola recepción persistente en D1. La liberación
de `blocked_policy` ocurre únicamente en la base efímera de esta prueba de
transporte; no constituye aprobación fiscal ni modifica configuración remota.

La variante `npm run d1:audit:checkout:isolated -- --queue-failure` inyecta un
fallo de escritura en la recepción D1, comprueba que no queda recibo parcial y
espera el reintento real de 60 segundos solicitado por el handler. Exige trece
ejecuciones terminadas (doce entregas originales y el reintento) y una sola
recepción persistente. Es optativa para no añadir esa espera a cada check local.

BEP-004 sigue incompleto: quedan el procesador fiscal, reconciliación y pruebas
de recuperación ante otras ventanas de caída. No hay consumidor conectado a
Beply ni desbloqueo automático de política.

`0011_fiscal_delivery_reconciliation.sql` registra el último envío confirmado.
El handler programado revisa, en lotes limitados, entregas publicadas hace diez
minutos sin recepción local: las devuelve a envío conservando el ID, o a revisión
manual tras diez intentos. Nunca desbloquea `blocked_policy` ni reenvía trabajos
con recepción persistente. Una entrega válida tardía puede registrarse incluso
tras agotar reintentos, sin autorizar emisión fiscal. Esta es reconciliación del
transporte D1/Queue, no conciliación de documentos o importes contra Beply.

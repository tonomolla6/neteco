# API B2B v1 y entorno sandbox

Este contrato ofrece lectura del catálogo publicado con precios públicos y un registro aislado de referencias de integración. **El registro no crea pedidos, presupuestos ni pagos**, ni aplica tarifas negociadas. Está diseñado para una clave por integración: los registros pertenecen a esa clave y una clave nueva no hereda los registros de otra. No se deben enviar datos personales, credenciales ni información comercial sensible como referencias.

## Contrato y acceso

Con la funcionalidad habilitada, `GET /api/b2b/v1/openapi.json` entrega OpenAPI 3.0.3. Las demás rutas usan `Authorization: Bearer <clave>`. Las claves se generan aleatoriamente con prefijos `sbx_` y `live_`; solo se muestra el secreto al crearlas y se persiste únicamente su SHA-256. Una sesión administrativa vigente, correo verificado, MFA y `administration.manage` son necesarios para emitir o revocar claves. Para live, cada clave exige una empresa aprobada vinculada a un cliente activo; suspender la empresa o bloquear el cliente impide su uso. Las claves sandbox no se vinculan a datos reales. Usa una clave por cliente/integración; entrégala por un canal seguro acordado fuera de este sistema. Si se pierde el secreto, revoca la clave y emite otra. La revocación requiere la versión actual y es irreversible.

Scopes: `requests.read` permite `GET /api/b2b/v1/catalog`, `GET /api/b2b/v1/requests` y, en sandbox, `GET /api/b2b/v1/sandbox/catalog`; `requests.write` permite `POST /api/b2b/v1/requests`. Cada clave tiene una cuota diaria UTC configurable entre 1 y 10.000 solicitudes admitidas. La cuota incluye reintentos y solicitudes autenticadas que luego fallen por validación. Hay un límite adicional de borde por IP, independiente y de mejor esfuerzo. Un 429 exige reducir tráfico; no implica que se haya registrado una solicitud.

La lista de catálogo admite `page` entre 1 y 1000, hasta 50 productos por página. La lista de referencias usa el mismo parámetro, hasta 100 por página. Los resultados son páginas con desplazamiento; los cambios concurrentes de catálogo o nuevas referencias pueden desplazar elementos entre páginas. No son una instantánea de exportación. Los parámetros desconocidos y páginas inválidas se rechazan.

Para registrar una referencia, envía JSON `{"reference":"ERP-123"}` a `POST /api/b2b/v1/requests` con `Idempotency-Key` de 1 a 128 caracteres ASCII alfanuméricos, punto, guion, guion bajo o dos puntos. Un reintento con la misma clave, entorno, generación y contenido devuelve la misma respuesta; con otro contenido devuelve 409. La referencia admite solo letras y dígitos ASCII, punto, guion, guion bajo o dos puntos; debe empezar por letra o dígito. Se recortan los espacios externos antes de validarla y calcular su huella. Las respuestas privadas llevan `Cache-Control: private, no-store` y los errores tienen forma `{"error":{"code":"..."}}`.

La lista administrativa de claves también está paginada en bloques de 100. La interfaz permite recorrer páginas y revocar una clave con su versión actual. Como usa desplazamiento, cambios concurrentes pueden mover elementos entre páginas; recarga antes de actuar.

## Sandbox y reset

Sandbox nunca consulta el catálogo real: ofrece un producto sintético y almacena referencias separadas de las claves live y de otras claves sandbox. Los datos visibles y las claves de idempotencia sandbox se reinician automáticamente a medianoche UTC; las claves y sus scopes permanecen activos. El mantenimiento programado retira como máximo 500 registros y 500 contadores antiguos por ejecución, por lo que la eliminación física puede retrasarse durante backlog o si el scheduler falla. Los registros live no se borran por este mantenimiento. La cuota consumida por cada clave se mantiene por separado. La prueba de aislamiento debe emplear únicamente datos sintéticos.

## Activación y operación

El montaje permanece deshabilitado salvo que `AUTH_ENABLED` y `B2B_PUBLIC_API_ENABLED` sean `true`, y requiere D1 migrado, límites de borde y configuración de autenticación existentes. Esta descripción no habilita flags, ejecuta migraciones, despliega ni configura proveedores. Antes de habilitar, verificar migración, rutas de acceso administrativas, cron real, límites de borde, cobertura de pruebas, capacidad y revisión del contrato; mantener los controles de producción del proyecto. La página de plataforma requiere navegación y permisos administrativos integrados. El panel de métricas cuenta claves activas y solicitudes admitidas del día UTC; no representa disponibilidad, latencia ni solicitudes rechazadas.

## Soporte y evolución

Para consultas generales, el cliente puede usar la página existente `/contacto` y señalar que la incidencia corresponde a la API B2B v1, sin incluir claves. El equipo de operaciones/plataforma debe registrar los responsables efectivos y el escalado en el gestor privado de guardias descrito en `incident-runbooks.md`; este documento no inventa un SLA específico para la API. Ante una clave comprometida, revocarla, conservar solo identificadores y timestamps en la incidencia, y emitir una sustituta por canal seguro. No copiar secretos a tickets o registros.

Cambios compatibles se incorporan a v1 sin romper campos o códigos documentados. Un cambio incompatible requiere otra versión de ruta y una comunicación previa a los clientes afectados con fecha de retirada y ruta de migración; no se ha aprobado una fecha ni una duración de preaviso para v1. Conservar la versión antigua hasta que operaciones apruebe la retirada y comunicar incidencias mediante el canal privado establecido.

## Changelog

- **1.0.0:** catálogo de precios públicos, registro idempotente de referencias, claves con scopes y cuota, y sandbox sintético con reset diario. Estado local de implementación; no implica publicación ni disponibilidad en producción.

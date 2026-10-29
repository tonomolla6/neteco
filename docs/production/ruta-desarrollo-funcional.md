# Ruta de desarrollo por funcionalidades — NETECO

Decisión del usuario, 4 de octubre de 2026: **el mismo resultado, menos tiempo**. Esta ruta sustituye el bucle por requisito y las colas históricas de microtareas. No reduce el alcance, cambia prioridades, certifica producción ni recupera las siete funcionalidades descartadas. El informe maestro conserva los criterios originales; `requirements-traceability.csv` conserva su evidencia.

## Corrección del flujo — 8 de octubre de 2026

### Cola por cursor y preparación por lotes — integrado el 9 de octubre, 23:56 UTC

`0086` completa la implementación local de cursor/selección/bulk de `UI-005`:
cursores cifrados de diez minutos ligados a filtros/orden/sesión, selección de
hasta 25 pedidos visibles, preview con versiones y elegibilidad reales, grupo
duradero y resultados por pedido. Un comando canónico por invocación conserva
CAS, MFA en el commit y claves idempotentes; los reintentos y la recuperación GET
no duplican transiciones ni efectos económicos o de inventario. La página vacía
por cambios concurrentes mantiene una vuelta y no anuncia filtros vacíos.

Pasan **357 Node únicos / 11 archivos**, incluido canary-source/workerd sobre
86 migraciones con entregas simultáneas, siete upgrades y presupuesto de queries
para 25 elegibles; **77 componentes / dos archivos**, tipos y checks afectados.
Compilación conjunta **PASS**: 8.998 entradas / 1.015 fuentes Nitro,
shop `d9fb0ffe…`, metafile `50346607…`.
[Contrato, hashes y límites](../cloudflare/README.md#cursor-order-queue-and-recoverable-bulk-preparation--local-checkpoint-2026-10-09).
No acredita navegador compilado, CI, escala operativa ni despliegue; `UI-005`
sigue `NOT_VERIFIED`. Próxima aceptación integral: 26 pedidos reales de prueba,
vistas/columnas, cursor, selección, respuesta perdida y cola compilada, en escritorio
y móvil. Se preservan 695 activos / siete descartados.

### Vistas privadas de pedidos y zoom gobernado — checkpoint local del 9 de octubre

`0085` incorpora hasta 20 vistas privadas por administrador, filtros/orden y hasta siete columnas
más el ID obligatorio; aplicar consulta explícitamente la página actual de 25 pedidos, sin operaciones.
CAS, archivo lógico y recibos inmutables recuperables mediante GET explícito conservan la historia
sin rePOST automático ni resucitar vistas archivadas. Autoridad viva y MFA real protegen el flujo.
El zoom gobernado conserva teclado/foco, movimiento reducido, alta resolución sólo abierto
y cierre al cambiar variante/fuente, sin aprobar por ello imágenes reales del catálogo.
Evidencia conjunta: **357 Node / 12 archivos**, dos nativos canary-source/workerd D1 sobre **85
migraciones**, siete upgrades; **245 componentes / seis archivos** en bandas 124/121; tipos
Worker/auditor/Nuxt, formato/lint afectados, trazabilidad de sólo lectura y diff pasan.
Compilación conjunta **PASS, 23:13 UTC**: 8.913 entradas / 1.009 fuentes Nitro,
shop `d49d4c18…`, metafile `f29dc838…`; [hashes y límites](../cloudflare/README.md#private-order-views-and-governed-product-zoom--local-checkpoint-2026-10-09), sin ejecución del Worker compilado, Chromium, CI ni despliegue acreditados.
`UI-005`, `PDP-004` y `MED-010` siguen `NOT_VERIFIED`: bulk/cursor completos, navegador,
aprobación de medios y despliegue pendientes. Se mantienen los 695 activos / siete descartados.

### Auditoría administrativa central — checkpoint de fuentes del 9 de octubre

`ADM-005` incorpora `0084`: 38 familias de acciones administrativas proyectadas
desde historia inmutable, revisión append-only con CAS, filtros/paginación y
exportación minimizada de hasta 1000 filas / 2.000.000 bytes (inferior a 2 MiB),
SHA-256 y ventana de acceso de descarga de 24 horas, sin prometer borrado físico.
No se copian motivos libres ni se inventan IP/sesiones históricas. Se excluyen
autoservicio de clientes, automatismos de proveedores, logs y cancelaciones
históricas sin audiencia administrativa probada. Los nuevos contextos de
cancelación provienen de audiencia/sesión vigentes y HMAC de IP de ingress.

La autoridad viva `administration.manage`, correo verificado y MFA se verifica
antes de lectura, commit, recuperación y descarga. La UI confirma recibos con
evidencia fresca, recupera resultados inciertos mediante GET explícito y no
repite POST automáticamente; descargar CSV exige una acción posterior y
verificación íntegra del archivo. Se purga estado privado al perder autoridad.
Evidencia focal: **15 núcleo / nueve HTTP / un nativo D1-workerd con 84
migraciones / 22 componentes**. Las tres reproducciones de integridad ya pasan
dentro de los 15 casos de núcleo. La banda Node conjunta final pasa **396 casos /
17 archivos**, incluidos los tres límites de exportación y siete upgrades
completos hasta 0084. La banda UI conjunta pasa **86 componentes / cinco archivos**,
incluidos los 22 de auditoría y regresiones de navegación/contexto/paleta. Tipos
Worker/auditor/Nuxt, formato/lint afectados, trazabilidad de sólo lectura y diff
pasan, sin alterar estados ni recuentos.

La compilación conjunta Cloudflare UI/Nitro, Worker dry-run y política del bundle
pasan aproximadamente a las **22:34 UTC**: **8.761 entradas / 1.004 fuentes Nitro**,
Worker de 10.479.850 bytes con hash `768024d5…` y metafile de 756.880 bytes con hash
`88588ed4…`. La prueba nativa usa canary-source sobre 84 migraciones, no ese
artefacto compilado; no acredita ejecución del Worker compilado, Chromium,
CI Oracle, proveedor ni despliegue.
[Contrato y límites](../cloudflare/README.md#central-sensitive-administrative-audit--source-checkpoint-2026-10-09).
`ADM-005` conserva `NOT_VERIFIED`; siguen 695 requisitos activos y siete
descartados. Los hashes ADM-004 de abajo sólo acreditan su lote histórico.

### Invitaciones administrativas — integrado y compilado el 9 de octubre, 21:50 UTC

`ADM-004` incorpora delegación segura a cuentas existentes, panel de equipo,
aceptación con MFA y bootstrap local explícito del primer administrador, sin
crear credenciales ni políticas predeterminadas. El ledger impide reutilizar
bootstrap como recuperación de privilegios. Las migraciones incrementales son
ahora **83**; la evidencia nativa usa canary-source y D1/workerd desechable,
no un despliegue ni navegador compilado. El secreto sólo vive en memoria del
cliente y el fragmento no se transmite mediante el redirect del login.
[Contrato y límites](../cloudflare/README.md#administrative-invitations-and-first-admin-bootstrap-2026-10-09).
La banda conjunta pasa **440 Node / 153 componentes**, tipos Worker/auditor/Nuxt,
formato/lint afectados y trazabilidad. La compilación conjunta UI/servidor,
Worker dry-run y política del bundle pasan: **8.672 entradas / 997 fuentes Nitro**,
shop `40d32792…`, metadatos `8009b82a…` (hashes completos en el enlace anterior).
La prueba nativa adicional pasa **1/1**, sin llamadas externas, pero no ejecuta
ese artefacto compilado en Chromium. CI, aprovisionamiento real y despliegue
siguen abiertos; los estados y el alcance de 695 requisitos no se promocionan.

### Checkpoint compilado anterior — 9 de octubre, 21:13 UTC

Integradas y compiladas conjuntamente las tandas de calendario/ETA, escalados
internos, promociones contextuales CMS, historial seguro de comunicaciones,
normalización de direcciones y telemetría promocional aditiva. El inventario
conserva las 81 migraciones incrementales. El fallo real de Nitro por un import
relativo del panel se aisló y corrigió usando el alias existente, sin relajar
la política del bundle.

La búsqueda distingue ahora error de API, carga y cero resultados confirmados;
su reintento GET explícito mantiene consulta y filtros. Búsqueda conserva noindex
sin canonical/alternates hacia una página noindex, manteniendo los canonicals de
catálogo, categorías paginadas y producto. Nuevas pruebas RED preceden ambos
cambios. La banda final conjunta pasa **266 pruebas Node y 34 de componentes**;
tipos Nuxt/auditor, formato/lint afectados, trazabilidad y diff-check pasan.

La compilación UI/servidor Cloudflare, Worker dry-run y auditoría del bundle
pasan: **8.574 entradas / 990 fuentes Nitro**, shop `a68b4791…`, metadatos
`229f5650…`. [Hashes completos y límites de evidencia](../cloudflare/README.md#local-compiled-checkpoint-2026-10-09-2113-utc).
No hay nueva aceptación de navegador compilado ni promoción CI/proveedor/despliegue.
No se reutiliza el intento REQUIRED51 consumido; el estado antiguo del lock no
se presenta como una comprobación actual. La demo Node no se reemplazó.

Siguen **695 requisitos activos y siete descartados**. Se actualiza evidencia
parcial, no estados completos ni un porcentaje artificial de lanzamiento.

### Checkpoint histórico — 9 de octubre, 19:24 UTC

**INV-010 integrado en fuentes**: CSV UTF-8 de hasta 100 filas / 64 KiB,
preview sin cambios de stock, diferencias y errores por fila, propuesta con
motivo/referencia y aprobación de otro operador. Todas las escrituras pasan
por el mismo Durable Object global; el lote D1 aplica todos los balances,
movimientos, auditoría y recibo o revierte completo. Las versiones y el estado
reconciliado impiden sobrescribir saldos cambiados. No se recupera multialmacén.

TDD ejecutado: 13 RED iniciales del núcleo; ocho caracterizaciones adicionales
reprodujeron cuatro fallos reales de normalización/deriva de SKU, correlación
temporal y capacidad de escritura. Núcleo **21/21 GREEN**, HTTP **20/20 GREEN**,
panel y regresión de página **28/28 GREEN**. La integración real de canary y la
clase del coordinador reprodujo ocho fallos antes del wiring, incluido un recibo
inyectado en caché; ahora pasa dentro de una banda conjunta de **366 pruebas**
que conserva operaciones y coordinador anteriores. El helper de auditoría pasa
dos pruebas contra canary/DO/SQLite real; sus seis escenarios no equivalen a
haber ejecutado todavía el bundle compilado. Una tabla errónea del harness se
reprodujo y corrigió sin cambiar lógica de negocio ni inventar confirmaciones.

El binding **workerd/D1/coordinador real pasa dos pruebas** con las 77
migraciones: 100 filas aprobadas/repetidas/recuperadas sin duplicados, y otro
lote de 100 con la última fila cambiada que deja cero ajustes y cero recibos
de aprobación. Cero outbound, runtime retirado. Una prueba dirigida adicional
reprodujo y corrigió la comparación Unicode del panel (NFC), sin cambiar
cantidades, permisos ni formatos aceptados.

La banda final integrada pasa **329 pruebas**; lint/formato globales y tipos
Worker/auditor/Nuxt pasan. UI Cloudflare, Worker y política del bundle compilados
pasan: **8.357 entradas / 972 fuentes Nitro**, shop `b3daaf28…`, metadatos
`cfe1e00b…`. El crecimiento físico propio de estos outputs es 376.832 bytes.

El auditor conserva las 49 jornadas anteriores y añade dos de recuento, con
77 migraciones. El único intento nuevo **REQUIRED51/77**, a las 19:22 UTC,
termina **NOT_RUN / global_lock_busy** antes de arrancar auditor o Chromium.
Otro trabajo tiene el lock E2E; no se ha interferido ni reintentado. Los seis
checks de limpieza local pasan; no se creó navegador remoto ni túnel. Esto no
es un fallo de producto ni aceptación de navegador. El último bundle nativo
aprobado conserva 363 escenarios / 76 migraciones; la aceptación compilada nueva,
Chromium, CI Oracle, proveedores y despliegue siguen pendientes.

Estados documentales y alcance siguen intactos: 695 requisitos activos, siete
descartados; 19,28% es evidencia documental, no porcentaje de plataforma terminada.

### Checkpoint histórico — 9 de octubre, 18:38 UTC

Integrados **CHK-018, guardar y compartir cesta**, y **CAT-010, relaciones
dirigidas de productos**. La cesta guardada conserva cantidades del servidor;
compartir es explícito, revocable y limitado a 24 horas, sin precios contractuales
ni identidad pública. Las relaciones requieren revisión manual y versiones CAS;
PDP, carrito y contexto de soporte usan la misma proyección pública canónica.
No se infiere reciprocidad, compatibilidad química ni sustitución automática.

CAT-010: 14 pruebas core, 12 HTTP, una canary/workerd real, 26 de interfaz y
seis del bridge pasan en bandas dirigidas. Otras 43 de CLI y devoluciones pasan;
las bandas no representan toda la suite. Tipos Worker/auditor/Nuxt, lint,
formato y diff-check dirigidos pasan. El auditor agotó su heap local de 1 GiB;
pasó con 2 GiB dentro de un scope de 3 GiB, sin cambiar cuotas del runner.
Un error de lint se corrigió con una validación equivalente de codepoints,
sin desactivar la regla.

**BUILD_COMPLETE `e3dee2ec…`**, metadatos `c5ec3107…`: UI Cloudflare, Worker
y política del bundle pasan, 8.285 entradas / 968 fuentes Nitro. La regresión
del bundle pasa **363 escenarios / 76 migraciones / cero outbound**. El intento
REQUIRED49/76 superó el fallo previo de devoluciones, pero se detuvo después
al enviar una empresa sintética con checksum fiscal obsoleto. El diagnóstico
HTTP real confirma el rechazo; IDs sintéticos y contrato de respuesta del
harness están corregidos. **No hay aceptación Chromium global nueva** y no
se repetirá el gate sin el siguiente lote integrado. El último bundle aceptado
en navegador sigue `586fcc1f…`, no el nuevo.

La prueba fallida retiró su runtime, procesos y túnel propios; seis comprobaciones
locales y tres remotas confirman limpieza. Pico observado del árbol del auditor:
2.124.828.672 bytes. Build: scope máximo 4 GiB, heap 2.560 MiB, swap 0, CPU 2,
presupuesto temporal 2 GiB y reserva de RAM 4 GiB. Outputs reutilizados:
84.840.448 → 85.164.032 bytes físicos (+323.584). Raíz antes/después del gate:
27.365.892.096 / 27.497.811.968 bytes, variación global no atribuida a Neteco.
Se conservan sólo los outputs, wrapper consumido y logs/resultados mínimos
necesarios para el diagnóstico. Sin instalaciones, expansión de disco/swap,
commit, push, Actions, despliegue ni proveedores reales.

El siguiente bloque **INV-010, importación de recuentos CSV del almacén único**,
ya tiene RED conductual: 13 fallos core por implementación ausente y 10 HTTP
por ruta ausente; un control CSRF existente pasa. Los agentes implementan
núcleo, API e interfaz en paralelo, con pruebas pesadas seriales. Preview,
diferencias, motivo y aprobación distinta; cualquier saldo obsoleto bloquea
todo el lote. No se añade multialmacén ni sobrescritura silenciosa.

Inventario sin inflar estados: 134 REPO_EVIDENCE / 121 PARTIAL_EXTERNAL /
5 MISSING / 227 NOT_VERIFIED / 208 ROADMAP_NOT_STARTED; 695 activos y siete
descartados. 19,28% sigue siendo evidencia documental, no completitud.
Oracle CI permanece en cuarentena con sus límites intactos; las aceptaciones
externas y el alcance completo siguen pendientes.

### Checkpoint histórico — 9 de octubre, 16:54 UTC

Integrados **CHK-016, referencia interna/PO**, y **PRI-012, simulador de cesta
y margen de mercancía**. La PO opcional se normaliza, queda congelada con la
intención idempotente y llega al pedido privado, administración y preparación;
no se mezcla con instrucciones ni campos fiscales. La migración 0074 conserva
pedidos históricos y evita alterar/reemplazar la referencia aceptada. El
simulador usa precios efectivos, tramos, IVA, cantidades y portes canónicos,
con costes reales de catálogo y sesión/MFA/permisos vigentes antes y después
de los awaits. No activa campañas ni escribe carritos, reservas o usos; la
cuota de seguridad HTTP sí se consume. Coste desconocido no significa cero,
y los portes cobrados no demuestran coste logístico ni beneficio total.

Tres agentes desarrollaron partes separadas, con una sola operación pesada
simultánea. TDD dirigido incluye histórico, replay, controles y normalización
PO, cuotas y revocación de privilegios durante lecturas de costes. Una prueba
RED reprodujo que dos comprobaciones HTTP separadas reabrían una ventana de
revocación tras el guard atómico del servicio: se eliminó sólo ese await
redundante. Otra RED detectó que la UI rechazaba una cesta cuya selección y
respuesta canónica tenían distinto orden; ahora correlaciona identidades y
cantidades, rechazando duplicados. El bridge comprueba costes y ausencia de
efectos contra D1, sólo deja pasar el POST privado del administrador y mantiene
el buyer bloqueado antes del dispatch. Se corrigió también el orden del journey:
simulación después de recuperar la activación, no durante la creación pausada.
Este orden se revisó en fuente; no se afirma ejecución de Chromium.

Evidencia final dirigida: 15 pruebas del motor, 15 HTTP y dos canary/workerd
reales con 74 migraciones pasan; regresión de checkout, 40; bridge, 10;
selectores/trazabilidad/configuración, 252; contrato CLI, 22. Las bandas se
solapan y no representan toda la suite. Tipos Worker, auditor y Nuxt pasan,
igual que formato/lint dirigidos y `git diff --check`. Un check de formato
del nuevo escenario del auditor falló y se corrigió con Prettier, sin relajar
ninguna prueba.

**BUILD_COMPLETE `b623bd1d…`**, metadatos `c39c5d17…`: UI Cloudflare, Worker
y política del bundle pasan, 8.134 entradas / 959 fuentes Nitro. La regresión
**del bundle compilado** pasa **361 escenarios / 74 migraciones, cero outbound**;
incluye simulación privada sin activación y sin cambios de dominio. REQUIRED
sigue **45 recorridos: 0 ejecutados / 45 pendientes**. No hubo SSH, lease,
túnel, navegador, Actions, commit, push, despliegue ni proveedor real. El último
bundle con aceptación de navegador sigue `586fcc1f…`, no el nuevo.

Se reutilizaron outputs y dependencias. Build/auditor: máximo 4 GiB, swap 0,
CPU 2, crecimiento presupuestado 2 GiB y reserva RAM 4 GiB; auditor y tipos
tuvieron límites efectivos comprobados en vivo. No se afirma pico final exacto
ni que el perfil de build quepa en el runner de 3 GiB. Raíz libre antes del
build/después del auditor: 27.594.313.728 / 27.466.342.400 bytes; variación global,
no ahorro atribuible. Outputs medidos: 121.712.640 → 122.187.776 bytes físicos
por `du`, incremento 475.136; los dos logs mínimos suman 110.858 bytes.
Ámbitos transitorios recogidos y runtime temporal del auditor retirado; bundle
y logs se conservan para el gate pendiente. El disco CI sigue en 7,92 GB
físicos y mantiene los 9,02 GB liberados, sin otro trim o expansión.

Inventario: 134 REPO_EVIDENCE / 121 PARTIAL_EXTERNAL / 5 MISSING /
226 NOT_VERIFIED / 209 ROADMAP_NOT_STARTED, con 695 activos y 7 descartados.
PRI-012 pasa a NOT_VERIFIED, no a aceptación; CHK-016 conserva su estado.
134/695 = 19,28% describe evidencia documental, no completitud. Oracle CI
continúa en cuarentena sin cambiar sus límites. Próximo bloque independiente:
CHK-018, guardar cesta como lista y compartir snapshot seguro revocable.
PRI-014 espera elección comercial de coexistencia cupón/descuento automático;
esta elección no bloquea el resto del desarrollo.

### Checkpoint histórico — 9 de octubre, 15:48 UTC

Integrado el recorrido de **cupones gobernados**: administración con MFA,
revisiones inmutables/CAS/recibos, elegibilidad server-side, checkout, pedido,
desglose fiscal y reembolsos parciales coherentes. Migraciones 0072–0073;
precios efectivos, tramos y `money.ts` siguen siendo las autoridades. Una
regla admite calendario/canal/segmento/ámbito y límites globales/por cliente.
No se crea ni activa ninguna campaña comercial. Un uso nace atómicamente con
el pedido aceptado, no con la cotización; incluye pedidos después abandonados
y no se restaura automáticamente al cancelar. El pedido de importe cero se
rechaza antes de reservar: no se inventa un flujo de pago gratuito.

Tres agentes trabajaron partes separadas; pruebas/builds pesados, seriales.
TDD dirigido cubre último uso concurrente, rollback y recuperación W2,
replay sin consumo, revocación del propietario, sustitución de filas
inmutables, histórico poblado y céntimos fiscales/reembolsables. Dos casos
nativos canary/workerd con D1, las 73 migraciones y el Cart DO real pasan.
La UI administrativa y de checkout/pedido tiene pruebas dirigidas verdes;
tipos Worker/auditor/Nuxt, lint y formato dirigidos pasan. Selector,
trazabilidad y configuración: 241 pruebas verdes; bandas solapadas, no
cobertura global. Un aviso real del primer bundle reveló el icono dinámico
de Promociones ausente: RED automatizado, corrección mínima y GREEN 4/4.

**BUILD_COMPLETE `fb1f35f2…`**, metadatos `acbff8f0…`: UI, Worker y bundle
policy pasan, 8.085 entradas / 954 fuentes Nitro. La regresión **del bundle
compilado** pasa 360 escenarios / 73 migraciones, cero outbound y cero avisos
del icono. Comandos finales: `npm run build:cloudflare-ui`,
`npm run build:worker-shop`, `npm run audit:shop-bundle` y
`npm run audit:shop:local -- --without-browser`, todos salida 0.
Es regresión local, no aceptación completa del nuevo journey de
cupón. Se preparan dos journeys adicionales, administración → cupón → pedido
recuperado, escritorio/móvil, sin pago/proveedor: REQUIRED **45/73, 0 ejecutados
/ 45 pendientes**. No se intentó SSH, lease, túnel ni navegador en este lote.
El último bundle con aceptación de navegador sigue siendo `586fcc1f…`.

Se reutilizan dependencias y outputs; build/auditor usan ámbitos transitorios
propios, MemoryMax 4 GiB, swap 0, CPU 2, crecimiento presupuestado 2 GiB y
reserva de RAM 4 GiB. Límites efectivos comprobados en vivo; no se afirma un
pico final exacto ni que este perfil quepa en el runner de 3 GiB. Raíz libre
antes/después: 27.785.736.192 / 27.788.333.056 bytes; variación global, no
ahorro atribuible. Ámbitos recogidos y runtime temporal retirado; outputs
retenidos para el gate pendiente. Cuatro logs mínimos de este lote conservan
222.615 bytes, incluidos el aviso original y su corrección.

PRI-013/016 y CHK-019 pasan de no iniciados a **NOT_VERIFIED**, no a aceptación.
Inventario: 134 REPO_EVIDENCE / 121 PARTIAL_EXTERNAL / 5 MISSING /
225 NOT_VERIFIED / 210 ROADMAP_NOT_STARTED; 695 activos y 7 descartados.
**134/695 = 19,28% es evidencia documental, no completitud del proyecto.**
Oracle CI continúa en cuarentena, sin ampliar RAM del runner; no hubo commit,
push, Actions, despliegue ni proveedores reales.

Próximo lote prioritario: **CHK-016, referencia interna/PO opcional** separada
de notas y datos fiscales, desde comprador hasta pedido y operación, con replay
e histórico. PRI-014 (descuentos automáticos) y PRI-012 (simulador real de cesta/
margen) son huecos posteriores identificados, no tareas ya realizadas.

### Checkpoint histórico — 9 de octubre, 14:28 UTC

Integrados los avisos atómicos de contraseña autenticada, activación MFA,
cambio de correo —dirección anterior y nueva— y presentación fiscal, sobre 0071. El export personal incluye únicamente los avisos del actor autorizado,
con destinatarios históricos, límites y revocación; el bridge los coteja con
D1. Unificado además el checksum fiscal español entre cuenta, agenda,
aprobación administrativa y checkout. Profesional exige identificador real;
agenda mantiene su opcionalidad. Otros países sólo tienen validación
estructural; no se afirma verificación tributaria. Node permanece intacto.

Tres agentes implementaron partes separadas y la CPU pesada fue serial.
Regresión conjunta: 395 pruebas en 14 archivos; interfaz: 129 en cuatro;
selector/trazabilidad/configuración: 212 en tres. Dos pruebas nativas pasan
contra workerd/D1 y 71 migraciones: cuatro flujos HTTP, cinco envíos simulados,
export histórico, rechazo ajeno/revocado y datos fiscales inválidos con 400
sin efectos de dominio/outbox. Tipos Worker/auditor/Nuxt, lint y formato
dirigidos pasan. Las bandas se solapan y no representan cobertura global.

**BUILD_COMPLETE `d15ea909…`**, metadatos `d2327e83…`: UI, Worker y política
Cloudflare pasan, 7.965 entradas / 948 fuentes Nitro. Un gate inicial bloqueó
el perfil de 4,5 GiB antes de arrancar. Se redujo el heap a 2.560 MiB y se
limitó el árbol a 3,75 GiB; pico observado 3.884.482.560 bytes, dentro del
presupuesto y manteniendo 4 GiB de reserva. Sin ampliar cuotas/swap/disco.
Raíz libre antes/después: 27.907.497.984 / 27.901.095.936 bytes; variación global,
no atribuida exclusivamente a NETECO. El monitor midió por error los tamaños
de `.output` legacy; la comprobación posterior identifica el output real
`.output-cloudflare` y no afirma crecimiento UI sin baseline inmediato.
Grupos propios vacíos; se conservan resultado/log y bundle pendiente.

Lectura SSH única a las 14:25:19 confirma titular vivo 3387871 y waiter
3441246 del lock compartido. No se adquirió lease ni arrancó navegador,
auditor o túnel. REQUIRED **43/71: 0 ejecutados / 43 pendientes**; nuevo wrapper
preparado, sin consumir. El último bundle aceptado sigue `586fcc1f…`.
Oracle CI continúa en cuarentena; no hay autorización para subir el límite
de RAM del runner. No hubo commit, push, despliegue ni proveedores reales.
CUS-007/012 siguen NOT_VERIFIED; 695 activos / 7 descartados, sin inflar estados.

Siguiente paquete identificado por fuente: cupón administrado hasta pedido,
fiscal y reembolso coherentes. Reutilizar precios/tramos y `money.ts`; el
contrato fiscal actual exige descuento cero y debe integrarse, no parchear
únicamente la UI. No se ha comenzado otra migración ni activado promociones.

### Checkpoint histórico — 9 de octubre, 13:26 UTC

El disco de CI se redujo por trim de bloques libres, sin borrar datos ni cambiar
su capacidad: 16.939.388.928 → 7.869.800.448 bytes físicos. Tras la aceptación de
servicios ocupa 7.915.466.752 bytes; sigue liberando 9.023.922.176 bytes respecto
al inicio. No se amplía swap, disco o cuota ni se limpia trabajo ajeno.

Oracle acredita ahora PostgreSQL/Redis privados, crun, límites efectivos e idmap
en la unidad real; los tres contenedores sintéticos se retiraron. Storage gate
y hook de recursos instalados coinciden con su fuente. La vista de memoria RO
funciona bajo UID980 sin abrir procfs. La admisión rechaza correctamente un pico
adicional de 4 GiB en el cgroup de 3 GiB: **CI sigue en cuarentena**, sin aprobación,
Actions ni pipeline certificado. Detalles en `docs/testing/neteco-e2e-server.md`.

El reset de contraseña completado crea su aviso de seguridad en la misma
transacción que contraseña/token/evento, sin secretos ni supresión comercial.
Diez casos dirigidos y las regresiones anteriores pasan; una prueba nativa real
workerd/D1 con 70 migraciones prueba HTTP, rollback y replay con un único envío
simulado y cero outbound. Los fallos D1 anteriores al envío conservan retry
acotado; un resultado desconocido del proveedor nunca se reenvía automáticamente.
CUS-005 sigue NOT_VERIFIED: faltan otros avisos y aceptación externa/operativa.

**BUILD_COMPLETE `b50dda07…`**, metadatos `fc67804b…`: Worker y bundle policy pasan
(7.929 entradas / 943 fuentes Nitro). Se reutiliza la UI compilada intacta,
verificada mediante digest completo; no se repite Nuxt. Un único intento
REQUIRED **43/70** termina inmediatamente a las 13:26:01 con `global_lock_busy`:
**0 recorridos ejecutados / 43 pendientes**. Auditor, navegador y túnel no
arrancaron; seis comprobaciones de limpieza pasan. No se reintenta ni se rebaja
el gate. Resultado mínimo conservado en
`/root/workspace/scripts/neteco-packing-required43-20261009/result.json`.
El último bundle aceptado sigue `586fcc1f…`, no el recién compilado. Alcance
695 activos / 7 descartados; 19,28% es evidencia documental, no completitud.
Sin commit, push, despliegue ni proveedores reales.

### Checkpoint histórico — 9 de octubre, 11:55 UTC

Integrado **seguimiento operativo privado** para el cliente propietario,
administración con MFA e invitado con el enlace/cookie de consulta existentes.
Reutiliza los hechos de preparación y la historia auditada completa de embalaje;
expone únicamente estado, bultos y referencias manuales no verificadas. No
publica costes internos, direcciones, razones, etiquetas ni credenciales. Una
expedición manual no se convierte en tránsito o entrega. El fallback explica
que el transportista no está conectado y permite contactar con NETECO.

Tres agentes implementaron datos, HTTP/D1 y pantallas en paralelo; las pruebas
pesadas fueron seriales. TDD: core 12 y regresiones 78; HTTP 21; canary fuente
contra workerd/D1 real y 69 migraciones, 1 prueba con 24 tablas intactas y cero
outbound; puentes tracking/packing 8; invitado 17; interfaz/montajes y regresiones 141. Integración raíz: 335 pruebas. No sumar bandas como cobertura única.
Tipos Worker/auditor/Nuxt, formato, lint y trazabilidad dirigidos pasan.

Una compilación conjunta pasa en 81,11 s: **BUILD_COMPLETE `8dec511f…`**,
7.853 entradas / 938 fuentes Nitro. Hash de metadatos `ed87134e…`; ambos
revalidados desde los archivos. No es aceptación de navegador ni producción.
REQUIRED conserva **43 recorridos / 69 migraciones**: tracking amplía los
recorridos existentes de embalaje y acceso invitado, sin crear otra base o lease.
Una única observación SSH de sólo lectura a las 11:53:01 confirma dos procesos
vivos en los registros del lock ocupado; no distingue al posible waiter.
**0 ejecutados / 43 pendientes**, sin GO, `attempted`, túnel, auditor o navegador.
El último bundle aceptado sigue siendo `586fcc1f…`.

Pico observado propio 4.194.254.848 bytes, dentro de 4 GiB más 4 GiB de reserva.
Outputs reutilizados: 80.505.924 → 80.659.623 bytes (+153.699); log 87.331 bytes.
Raíz libre antes/después del build: 28.800.069.632 / 28.779.728.896 bytes; la
variación global no se atribuye a NETECO. Runtime propio retirado y grupos de
procesos vacíos; se conserva resultado/log/bundle para el gate pendiente y se
retira el wrapper de build verificado (10.459 bytes). El wrapper REQUIRED previo
permanece intacto y sin consumir. No hubo instalaciones, copias de repositorio,
commit, push, despliegue, proveedor ni cambios del CI instalado.

SHP-015 mantiene **PARTIAL_EXTERNAL**: faltan preferencias de comunicación
preentrega, carrier real y aceptación desplegada. El seguimiento no renueva ni
amplía los plazos originales del invitado. Oracle CI continúa en cuarentena;
695 requisitos activos / 7 descartados, sin inflar estados.

### Checkpoint histórico — 9 de octubre, 11:20 UTC

Integrado el lote de **embalaje multibulto, expedición manual y costes**
(SHP-013/018/020), sin cambiar stock, cobros ni el estado de preparación.
Los bultos asignan exactamente las unidades contractuales y conservan medidas,
peso y revisiones auditadas. La expedición exige referencias por cada bulto y
preparación pagada/asignada/embalada confirmada. Registra coste real declarado,
IVA redondeado por la autoridad monetaria existente y diferencia frente al porte
contractual. Las referencias de etiquetas son **no verificadas**: no hay PDF,
envío al transportista ni confirmación externa inventada.

El panel exige sesión/capacidad vigente, revisión explícita y recibo más estado
actual para confirmar. Una respuesta perdida conserva la intención y sólo se
recupera mediante GET; los rechazos directos de versión permiten consultar de
nuevo, sin repetir automáticamente el POST. Core 18, HTTP 21, puente Node 5 y
nativo canary/workerd D1 con 69 migraciones pasan; la prueba nativa conserva 21
tablas de dominio/autorización y cero outbound. Interfaz/montaje: 41/42 pasan
en banda y el caso restante pasa después como focal; regresión legacy 18 pasa.
La integración raíz pasa 326 y los upgrades SQLite/D1 7, manteniendo baselines
poblados y rollback/retry de 0066. Las bandas no deben sumarse como cobertura
única. Tipos Worker/auditor/Nuxt, formato, lint y trazabilidad dirigidos pasan.

Nueva compilación `56e5538a…`: UI Cloudflare + Worker shop + política del bundle
pasan en 97,13 s, 7.806 entradas / 934 fuentes Nitro. Es **BUILD_COMPLETE**,
no aceptación de navegador o producción. El último bundle aceptado continúa
siendo `586fcc1f…`. REQUIRED **43 recorridos / 69 migraciones** conserva los 41
anteriores y añade embalaje/expedición en escritorio y móvil. Una observación
SSH de sólo lectura a las 11:17:57 confirma el lock global ocupado por dos
procesos: **0 ejecutados / 43 pendientes**, sin GO, lease, túnel, auditor ni
navegador. Wrapper preparado y revisado en
`/root/workspace/scripts/neteco-packing-required43-20261009/run.cjs`, sin
`attempted` ni resultado. No hay reintentos ciegos ni gate rebajado.

Outputs reutilizados: 80.219.403 → 80.585.313 bytes (+365.910), log 86.305 bytes.
Raíz libre antes/después: 28.285.857.792/28.294.103.040 bytes; la variación global
incluye otros trabajos y no es ahorro atribuible. Pico observado propio
4.135.800.832 bytes, dentro de 4 GiB más 4 GiB de reserva; una compilación,
sin instalar dependencias ni duplicar repositorios. Se retira el script temporal
de build ya verificado (6.614 bytes); se conserva su resultado y el bundle
necesario para el gate pendiente. Disco CI: 7.869.800.448 bytes físicos, ahorro
previo intacto de 9.069.588.480. Oracle CI sigue en cuarentena, sin push/deploy ni
proveedores. Los tres requisitos mantienen PARTIAL_EXTERNAL; no se certifican
etiquetas reales, procedimiento operativo, conciliación de facturas o despliegue.
El alcance sigue siendo 695 activos / 7 descartados.

### Checkpoint histórico — 9 de octubre, 10:40 UTC

La compilación nueva `baa7875c…` incorpora satisfacción opcional tras soporte
resuelto/cerrado o entrega confirmada, sobre el lote anterior de inventario,
pedidos y cuenta. UI Cloudflare, Worker shop y política del bundle pasan:
7.749 entradas / 930 fuentes Nitro, en 77,77 s. Es **BUILD_COMPLETE**, no aceptación
de navegador ni producción. El último bundle aceptado sigue siendo `586fcc1f…`.

SUP-010 permite puntuación 1–5 y comentario privado sin condicionar soporte ni
cambiar pedidos, cobros o stock. Exige cliente registrado vigente, propiedad,
versión de la fuente y hash exacto de la política mostrada. Una política nueva
no amplía el plazo de comentarios anteriores. El panel recupera recibos sin
repetir la escritura y retira datos privados ante 401/403. El resumen admin
segmenta resultados y sólo muestra comentarios con selección explícita.
La purga física automática, invitaciones seguras de invitados, aprobación real
de política/retención y operación desplegada no están cerradas.

Tres agentes implementaron core, HTTP/nativo e interfaz/puente en paralelo;
las suites se serializaron. Core/schema/adversarial 25, HTTP 21 y puente Node 6
pasan. La interfaz pasa 36 casos y, tras el último guard, sus 7 regresiones
focales; las pruebas previas de montaje también pasan. La integración raíz
ejecutó 231 casos: 197 de runtime/configuración/selector/nativo pasan; el único
fallo fue el recuento documental de fechas revisadas. Corregido ese recuento,
la banda documental pasa 34/34. La prueba nativa final utiliza canary real,
workerd D1 y 68 migraciones, con dos valoraciones, replays y 17 tablas económicas
y de autorización intactas; cero outbound. Tipos Worker/auditor/Nuxt, lint,
formato y requirements audit dirigidos pasan. Las bandas se solapan y no se suman.

El gate compilado conserva los 39 recorridos anteriores y exige **41/68**,
añadiendo satisfacción en escritorio/móvil. Observación remota de sólo lectura
a las 10:39:09 confirma el lock global ocupado: **0 ejecutados / 41 pendientes**.
No se adquirió lease ni se inició auditor, navegador, túnel o D1 para este lote.
El wrapper preparado en
`/root/workspace/scripts/neteco-sup010-required41-20261009/run.cjs` queda sin
`attempted` ni resultado de ejecución. No se repite a ciegas el intento 39,
ni se rebaja el gate ni se ejecuta el auditor completo en el host remoto.

Se conservan los outputs reutilizados y un log de 86.617 bytes. El crecimiento
medido de los tres outputs es 363.432 bytes. Raíz libre antes/después del build:
29.416.509.440/29.409.329.152 bytes; la variación global incluye actividad ajena.
Pico observado del árbol propio: 4.185.047.040 bytes, dentro del presupuesto 4 GiB
más 4 GiB de reserva. Sin instalaciones ni nuevas copias de dependencias.
El disco CI mantiene 7.869.800.448 bytes físicos: ahorro atribuible 9.069.588.480.
Oracle CI continúa en cuarentena; sin commit, push, deploy ni proveedores.
El inventario conserva 695 activos / 7 descartados y SUP-010 sigue NOT_VERIFIED.

### Checkpoint histórico — 9 de octubre, 09:57 UTC

La nueva compilación `6d5ffc66…` incluye las alertas operativas de inventario,
además del lote anterior de pedidos/cuenta/soporte. UI Cloudflare, Worker shop
y política del bundle pasan: 7.690 entradas / 925 fuentes Nitro, en 82,08 s.
Esto es **BUILD_COMPLETE, no aceptación de navegador**. El último bundle
aceptado sigue siendo `586fcc1f…`, con 385 escenarios, 63 migraciones y 25
recorridos Chromium.

INV-011 aporta umbrales separados del stock de seguridad, un único episodio
activo por variante, reconocimiento auditado y resolución por recuperación.
GET distingue el episodio de los hechos actuales y no cambia stock. El panel
configura el umbral desde una variante confirmada por SKU y recupera respuestas
perdidas mediante recibo y GET exacto, sin repetir la escritura. El evaluador
acotado reutiliza el Cron existente, con cursor durable y flag OFF por defecto;
un fallo fiscal no lo interrumpe. No se incorpora multialmacén ni envío de correo.

Pasan core21, HTTP43, interfaz53 y una prueba nativa con canary real, workerd D1
y las67 migraciones: evalúa100 posiciones/99 anomalías sintéticas y comprueba
que las alertas no cambian existencias. El montaje/configuración y regresiones
dirigidas pasan219; CLI/selector157 y helper de navegador8 también pasan.
Estas bandas se solapan y no deben sumarse como pruebas únicas. Worker, auditor
y Nuxt pasan tipos; lint, formato, requirements audit y diff-check dirigidos pasan.
El inventario mantiene695 requisitos activos/7 descartados y no se promueve
INV-011 por evidencia indirecta.

El gate conserva los37 recorridos anteriores y exige **39 recorridos Chromium/67
migraciones**, añadiendo alertas en escritorio y móvil. La adquisición única y
no bloqueante de09:56 terminó en `global_lock_busy` (flock75): **0 ejecutados,
39 pendientes**. La admisión local pasó, pero no se crearon navegador, túnel,
auditor ni D1; cleanup confirmado y hashes intactos. Se conserva la evidencia en
`/root/workspace/scripts/neteco-inv011-required39-20261009/result.json` sin retry.
El intento anterior37/66 tampoco inició navegador. No se repite el bundle990b,
se rebajan gates ni se trasladan auditoría/instalaciones al servidor remoto.

El código del gate de almacenamiento CI contempla ahora capacidad/10% y el
crecimiento de la imagen sparse en ambos volúmenes; pasa80 pruebas dirigidas.
Su instalación efectiva sigue pendiente: Oracle CI conserva la cuarentena y no
se acredita ningún pipeline. Sin commit, push, despliegue ni proveedores.

El build conserva sus artefactos para el gate pendiente, sin duplicar dependencias.
Raíz libre antes/después:29.596.733.440/29.582.204.928 bytes; la variación global
incluye otros procesos. Los cuatro outputs medidos crecieron427.131 bytes y el
log retenido ocupa84.841. El RSS máximo de un hijo fue3,36GiB, superior al pico
estimado de3GiB: próximos builds presupuestarán4GiB más4GiB de reserva, sin usar
swap como margen. El trim previo conserva el ahorro atribuible de9,07GB.

### Checkpoint histórico — 9 de octubre, 08:53 UTC

El estado aceptado sigue siendo `586fcc1f…`: 385 escenarios, 63 migraciones y
25 recorridos Chromium. El build posterior `ee21ce08…` no está aceptado: su
required falló con 359 escenarios, al descubrir que el detalle HTTP del pedido
devolvía `untracked` aunque D1 confirmara la entrega. La proyección real está
corregida y pasa las regresiones HTTP/SQLite/workerd; no se ocultó el fallo en
el auditor. El titular de la página también distingue preparación y entrega.

La compilación nueva `990b2d7b…` pasa UI Cloudflare, Worker shop y política del
bundle: 7.640 entradas / 921 fuentes Nitro. Su siguiente gate conserva los
35 recorridos previos y exige **37 recorridos/66 migraciones**, añadiendo dos
de consulta de invitado desde correo, escritorio y móvil. No se ha ejecutado
todavía ni se hereda la aceptación del bundle anterior. El acceso de invitados ya intercambia un HMAC
de consulta por cookie privada y rechaza aliases con token antes de SSR;
no autoriza pagos. El correo existente ya genera ese enlace únicamente desde
un checkout confirmado, en memoria y con revalidación antes de enviar; conserva
los envíos desactivados. Acceso/correo/dispatcher pasan 56 pruebas, incluido
workerd con las 66 migraciones. Las entradas pasan doce; la interfaz de pago
pasa 24 y no ofrece acciones de pago ni afirma que una reserva viva caducó por
ser un enlace de consulta. El soporte contextual conserva producto/categoría
hasta el expediente y purga borradores al perder autoridad: 91 pruebas en cinco
archivos. El helper nuevo de invitado pasa 13 pruebas de contrato HTTP real,
sin acreditar Chromium por ellas. Integración CLI/selector: 145/145, tipos del
auditor, lint y diff-check verdes. El selector registra 338 archivos únicos,
sin elevar estados. Soporte contextual conserva pendiente su recorrido de
navegador; el nuevo gate no lo acredita indirectamente.

La integración dirigida posterior pasa 241 pruebas en siete archivos; incluye
checkout/pedidos HTTP/D1 reales y el wiring efectivo Cron→dispatcher con el
flag de envío apagado. Las bandas no deben sumarse como casos únicos ni como
funcionalidades terminadas. Tipos Worker/auditor/Nuxt, formato y lint dirigidos
y diff-check pasan. No equivalen al gate global de CI.

Tono pidió reducir el disco CI creado a las12:55. Un trim del ext4 propio redujo
la ocupación física de su imagen de16.939.388.928 a7.869.800.448 bytes: ahorro
atribuible9.069.588.480, sin borrar archivos ni cambiar la capacidad lógica de
16GiB. La imagen ahora es sparse, no reserva física completa. El build local
pudo terminar; no se compiló en el servidor E2E ni se admitieron jobs CI.

La nueva política de recursos se aplica antes de otro trabajo pesado. El disco
actual tiene margen, pero el gate RAM del auditor está bloqueado:5,14GiB
disponibles frente a2,5GiB de pico estimado más4GiB de reserva. Swap no cuenta.
No se abrió lease, túnel ni navegador, ni se pararon procesos ajenos. El gate
pendiente sigue required37/66: no se rebaja ni se usa `--without-browser`.
El estudio de sólo lectura considera viable probar allí el bundle ya compilado,
pero faltan Node24 y dependencias del auditor. Ampliar la autorización actual
de Chromium a la auditoría manual completa requiere aprobación expresa; no se
copia ni instala nada por este estudio. Oracle CI sigue
en cuarentena, sin pipeline acreditado. Envío a proveedores, CI, commits y
despliegues siguen fuera de esta ejecución.

### Detalle histórico del lote — 22:15 UTC

El trabajo actual cierra recorridos compartidos, sin cambiar el alcance ni
confundir evidencia de repositorio con producción terminada:

- **Pedidos operables:** exportación CSV privada con filtros compartidos y
  búsqueda literal de NIF/CIF; notas y etiquetas internas con historial,
  recuperación de recibos e independencia de los datos visibles al cliente.
- **Correos transaccionales:** fuentes atómicas de preparación/entrega,
  cancelación, devolución y captura de pago. Se conserva el outbox existente,
  opt-ins vacíos y envío desactivado. Las pruebas usan destinatarios sintéticos
  y un remitente simulado, nunca proveedores de producción.
- **Cuenta:** perfil/B2B, direcciones y seguridad validan contratos reales y
  límites de sesión; los resultados ambiguos no autorizan reenvíos automáticos
  ni mensajes de éxito sin confirmación. Seguridad e inventario ya forman
  parte de la compilación conjunta; sus pruebas de componentes no equivalen
  a certificar todos sus recorridos de navegador.
- **Navegación admin:** un recorrido compilado encontró el panel atascado en
  «Comprobando permisos», pese a respuestas HTTP correctas. La reproducción
  con composable/layout reales falla antes del cambio y pasa después: se usa
  la ruta inmediata del router, sin relajar sesión ni permisos. El arreglo
  también pasa el recorrido real de Chromium en escritorio y móvil.

La compilación congelada `586fcc1f…` pasa **385 escenarios, 63 migraciones,
25/25 recorridos de Chromium y cero outbound**. Los correos verifican seis objetivos vigentes,
quince fuentes obsoletas y el mismo digest del dominio antes/después; no prueban
todos los estados de envío ni entrega real en buzones. Los recorridos nuevos
de historial/notas y cancelación comprueban respuestas perdidas y recuperación
manual, sin duplicar la escritura. El intento anterior falló realmente en el
montaje administrativo y sigue registrado como fallo previo, no como aprobado
retroactivo. Se cerraron y verificaron los recursos efímeros del navegador y
el túnel. No se ha hecho deploy ni ejecutado el gate global de CI.

La primera tanda posterior pasa **327 pruebas de interfaz en once archivos**.
La integración de privacidad/avisos pasa después **95 pruebas en cuatro archivos**;
las 31 de newsletter/comunicaciones están en ambas bandas y no deben sumarse.
La regresión final dirigida pasa **258 pruebas Node en doce archivos**, seguida
de tipos Worker/auditor/Nuxt. El registro documental/selector actualizado pasa
135 pruebas propias y contiene 323 archivos únicos de test.
Incluye devoluciones, newsletter, favoritos, resumen de cuenta y revisión de
empresas D1: las confirmaciones requieren recibos válidos y lecturas actuales;
se purgan datos privados al perder autoridad y se detienen lotes de carrito
tras una entrega incierta. El inventario conserva la intención original ante
replays limitados. La revisión B2B no concede crédito, roles ni aprobación
fiscal externa. Estos cambios posteriores **no heredan** la aceptación del
bundle `586fcc1f…`. Todos forman ahora la compilación `eac817fd…`, cuya UI,
Worker y política de bundle pasan: 7.571 entradas, 917 fuentes Nitro y
8.963,80 KiB / gzip 1.909,87 KiB. El build intermedio `88420771…` queda histórico;
no sustituye la aceptación pendiente de este nuevo bundle.

El auditor conserva los 25 recorridos anteriores y añade cuatro RMA y dos B2B:
**31 recorridos exigidos** y 66 migraciones completas. La primera ejecución
required falla con 359 escenarios completados: el nuevo selector RMA esperaba
una fila cerrada aunque la pantalla abre el primer pedido. No fue un fallo de
creación/entrega ni prueba de aceptación. La reproducción focal falla antes del
arreglo y las 15 pruebas del helper pasan después; sólo cambian auditor y tests,
no la aplicación ni sus assets. Sus recursos privados quedaron cerrados. Una
segunda ejecución autorizada también falla con 359 completados: el auditor
buscaba el panel de devoluciones dentro de la fila, pero la aplicación lo monta
en `/devoluciones?pedido=…`. Se corrigió el recorrido completo desde el enlace
real de pedido y el refresco en su página; las 17 pruebas focales pasan. Ambos
fallos permanecen registrados y todos sus recursos privados quedaron cerrados.
No se abrió una tercera ejecución del mismo lote incompleto.
El preflight local volvió a pasar con unos 4,5 GiB antes del build, sin bajar
umbrales ni borrar datos ajenos. No hizo falta copiar ni compilar código en el
servidor E2E; la consulta anterior de autorización remota queda superada por
esta compilación local.

Privacidad y preferencias genéricas **ya están integradas en código** en la
página Cloudflare y en el dispatcher Worker, no en la compilación aceptada.
Las API privadas comprueban propietario y sesión actuales, CSRF y recibos
duraderos. La exportación JSON minimizada falla al superar sus límites;
anonimización sólo registra intención pendiente, sin borrar datos financieros
ni certificar retención legal. Los avisos de producto y reposición mantienen
consentimientos separados, defaults apagados y newsletter independiente:
guardar no envía mensajes, activa automatizaciones ni prueba suppression en ESP.
El padre conserva Node, purga límites de sesión y bloquea runtime desconocido
sin llamar a sus APIs. CUS-008/010/012 registran evidencia parcial, no aceptación.
Oracle continúa bloqueado por presupuesto de almacenamiento,
no por falta de tareas locales.
La comprobación nueva de migraciones pasa siete casos SQLite/workerd D1:
vacío→0066, upgrades poblados desde 0055/0062, permisos y restricciones después
del upgrade, rollback ante fallo y reintento forward. No se detectó un defecto
de las migraciones ni se inventa un RED. El Cron sí tenía un fallo reproducido:
un error fiscal impedía publicar correos independientes ya comprometidos. El
arreglo conserva las cadenas reconcile→publish y el rechazo observable al
terminar; su banda focal pasa 41 pruebas. Este arreglo posterior **no está en
el bundle `eac817fd…`**. Ambos requisitos pasan de hueco documental a
implementación parcial NOT_VERIFIED, no a aceptación.

El lote siguiente incorpora pedido rápido público por SKU/EAN/CSV, preview
acotada de cantidades, IVA y descuentos, selección explícita y adición con el
carrito existente. Una respuesta incierta detiene las líneas no enviadas; la
consulta no reserva ni modifica stock. Sus 29 pruebas de lógica, 29 de interfaz
y tres HTTP/D1 reales pasan; las 24 pruebas de navegación conservan Node y
exponen el enlace Cloudflare en escritorio/móvil. SEA-017 y CUS-026 registran
implementación parcial, no cotización contractual completa ni aceptación.
La banda conjunta final pasa 197 pruebas Node en cinco archivos; el selector
conserva 329 archivos únicos. Tipos Worker/auditor/Nuxt pasan.

La compilación conjunta `ee21ce08…` pasa UI, Worker y política Cloudflare:
7.604 entradas, 919 fuentes Nitro y 8.981,19 KiB / gzip 1.913,38 KiB. Incluye
pedido rápido/navegación y el arreglo del Cron. Conserva los 31 recorridos y
añade dos de preferencias/privacidad: **33 recorridos de navegador exigidos**,
66 migraciones. Su ejecución privada falla con 359 completados al buscar el
enlace de devolución. Se localiza ahora un defecto real: el DTO del detalle
hardcodea `untracked` aunque D1 confirme la entrega; una reproducción HTTP con
D1 real falla por ese desacuerdo. No se modifica el auditor para ocultarlo.
Sus recursos privados quedaron cerrados. Los dos recorridos de pedido rápido
ya tienen helper y 27 pruebas focales; todavía no han ejecutado Chromium.
Un arreglo posterior del titular del pedido pasa RED→29 GREEN y
distingue preparación/tránsito/entrega confirmados; no está en ese build ni
hereda su aceptación. Los tres agentes mantienen partes independientes.
El inventario conserva **695 requisitos activos y siete descartados**; su
19,28 % documental no representa el porcentaje de desarrollo terminado.

Esta sección sustituye las prioridades de los checkpoints históricos de abajo. El usuario rechaza continuar semanas con trabajo abierto y un porcentaje inmóvil. La revisión del inventario completo encuentra que el porcentaje publicado procede de listas manuales de `REPO_EVIDENCE`, no de ejecución de criterios. Las fechas de fallback tampoco prueban una verificación. No se usará ese cociente como porcentaje de desarrollo terminado ni se incrementará por añadir código, fixtures o tests.

El problema no requiere otro planificador: el selector existente ya deduplica suites y agrupa proyectos. Se cambia la ejecución efectiva:

1. **Cola de cierres operables, no otra expansión de subcomponentes.** Cada paquete de abajo conserva todos sus criterios originales y distingue implementación ausente, integración/validación pendiente y aceptación externa. La primera prioridad es que los recorridos ya construidos funcionen de extremo a extremo y no tengan pantallas con APIs inexistentes. Las fases posteriores siguen dentro de los 695 requisitos activos.
2. **Capacidad continuamente ocupada con propiedad exclusiva.** Esta sesión permite tres subagentes y el principal. Cada agente recibe un contrato y archivos propios; al entregar se reasigna a la siguiente parte independiente. No se congela a todo el equipo durante un gate ni se deja un slot esperando un bloqueo de infraestructura. El principal integra los archivos compartidos y revisa una sola entrega a la vez. Si no hay tres partes realmente independientes, se explica la dependencia, no se fabrican microtareas.
3. **TDD de comportamiento, ejecución agrupada.** Se prepara la matriz completa del paquete y se ejecutan RED/GREEN específicos. Las unitarias Node no deben inicializar Nuxt. Las consultas nuevas de D1 se prueban también de forma enfocada contra workerd, antes del build y del recorrido completo: SQLite no reproduce todos los límites de D1. El principal ejecuta una regresión conjunta de los cambios integrados; los builds y el gate completo corresponden a un estado congelado, no a cada ID, agente, mensaje de estado o pequeño ajuste. Un cambio posterior invalida las comprobaciones afectadas. No se omiten cobertura, flakiness, browser, accesibilidad, escala ni aceptación exigidas para el cierre correspondiente.
4. **Infraestructura como frente separado, no monopolio del principal.** Oracle, contenedores, BuildKit y admisión siguen bloqueando CI/promoción hasta tener evidencia real. Un gate de almacenamiento fallido no autoriza limpiarlo todo, bajar umbrales ni usar runners alojados; tampoco bloquea implementar y comprobar localmente funciones independientes. No repetir probes sin cambio relevante o un handle real que observar.
5. **Una entrega y un registro por cierre.** El informe identifica recorrido entregado, criterios demostrados, fallo pendiente concreto y siguiente paquete. No añade varias crónicas extensas por cada corrección ni presenta el número de tests como funcionalidades terminadas. Un fallo confirmado se reproduce y corrige; no se abren indefinidamente variantes especulativas de un componente ya aceptado mientras otros flujos están ausentes.

### Cola de resultados completos

Los paquetes son orden de integración, no otro inventario que sustituya los quince módulos. La pertenencia exhaustiva de cada ID continúa en `shared/functional-delivery-plan.ts`; los siete descartados no se recuperan.

| Paquete                          | Resultado de cierre                                                                                                                             | Dependencias principales                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| P1 — Tienda y catálogo operables | Importar, corregir, publicar, localizar y comprar desde móvil; administración sin rutas rotas, búsqueda gobernada y listados acotados.          | Identidad y contratos de catálogo existentes; datos/derechos/scanner reales se aceptan por separado. |
| P2 — Resolución económica        | Comprar, cobrar, facturar, cancelar/devolver y recuperar un reembolso/rectificativa sin duplicar dinero ni stock.                               | P1 y contratos financieros; no sustituir el contrato Beply pendiente por una simulación.             |
| P3 — Pedido entregado            | Preparación, expedición, bultos/etiqueta, tracking, entrega/incidencia y retorno en el único almacén.                                           | P2, transportista, recogida/reparto y políticas operativas reales.                                   |
| P4 — Atención y comunicación     | Contacto seguro, expediente, escalado/SLA, conocimiento buscable, resolución y seguimiento; contenido y newsletter coordinados.                 | Contexto de P1–P3, identidad y consentimiento.                                                       |
| P5 — Aceptación de lanzamiento   | CI Oracle verificado, Cloudflare por entorno, seguridad/legal, accesibilidad, cobertura, navegadores, carga, observabilidad y restore/rollback. | Frente transversal desde P1; sus bloqueos no paralizan desarrollo local independiente.               |
| P6 — Conversión y retención      | Promociones y simulación, bundles, automatizaciones, recomendaciones/reseñas y medición coherente.                                              | P1, P2, P4 y P5.                                                                                     |
| P7 — B2B y operación avanzada    | Tarifas/crédito/presupuestos/pedido rápido, compras/costes/trazabilidad, escaneo y rutas/PWA; sin multisede ni multialmacén.                    | P2, P3, P4 y contratos comerciales/fiscales.                                                         |
| P8 — Inteligencia y mercados     | Forecast/recomendación evaluados, internacionalización y omnicanal con aprobación, límites y fallback.                                          | P5–P7 y datos autorizados suficientes.                                                               |

Lanzar requiere los paquetes aplicables P1–P5 y las autorizaciones correspondientes; **no equivale a terminar todo el alcance**. P6–P8 siguen pendientes hasta satisfacer sus criterios, no se convierten en descartados ni en trabajo opcional. Ningún paquete se considera cerrado por esta planificación.

Acciones implementadas en este lote: perfil unitario Node sin arranque Nuxt; caché únicamente del texto inmutable de migraciones, conservando bases nuevas y claves foráneas; dos observaciones CI por test en vez de tres, con cobertura/JUnit y fallos bloqueantes; sinónimos administrables D1 integrados con búsqueda pública; conocimiento público con autoría CMS y feedback; navegación administrativa por capacidades vivas y command palette; indicadores operativos de SLA y siguiente acción vencida. Tres agentes implementaron partes independientes y fueron reasignados; el principal integró rutas, contratos y regresiones compartidas.

Checkpoint del lote, 8 de octubre: 192 pruebas de componentes en una tanda; regresión de soporte/newsletter/CI de 121 pruebas; regresión final conjunta de búsqueda/facetas/conocimiento de 138 pruebas en diez archivos, incluidas consultas D1 reales; tipos Worker/auditor/Nuxt y build Cloudflare/política del bundle aprobados. `npm run audit:shop:local -- --without-browser` termina con `passed_browser_pending`: 308 escenarios, 62 migraciones y cero llamadas salientes. Se comprueban los sinónimos, la publicación/búsqueda/retirada de conocimiento, feedback recuperable y los doce casos completos de macros. Quedan pendientes los 17 escenarios de navegador previstos por ese auditor, la aceptación de interfaz/UAT y el CI Oracle real; no es un gate global aprobado ni aceptación de producción.

Fallos reproducidos y corregidos durante la integración: búsqueda/facetas superaba la profundidad SQL de D1; consultas largas de búsqueda y ayuda superaban su límite de patrones LIKE; y un test mezclaba relojes CMS/newsletter al cruzar un segundo. Hay regresiones enfocadas workerd para términos de 160 caracteres, sinónimos largos y `%`, `_` y `\` literales. Los candidatos se materializan y la búsqueda literal usa `instr`, sin rebajar autoridad, filtros, entradas ni cobertura. Un contador incorrecto del auditor de macros se sustituyó por la comprobación de sus doce casos concretos, sin eliminar ninguno.

El selector reúne 246 archivos únicos en quince módulos y conserva 695 requisitos activos y siete descartados. SEA-005, SUP-007 y UI-003 registran sus archivos y límites concretos; sus estados amplios siguen NOT_VERIFIED. El 19,28 % publicado por el inventario significa sólo evidencia documental. No es porcentaje del producto terminado. Los siguientes huecos se extraen de los recorridos P1–P4; no se vuelve a expandir el importador para aplazar esos cierres.

### Recorridos de pedido y navegación — siguiente lote del 8 de octubre

Listado y detalle privados ya leen la preparación confirmada de D1: preparación, listo para recoger, enviado y entregado se distinguen sin inventar tracking ni revelar notas internas. El detalle oculta datos obsoletos durante errores, cambios de sesión y relecturas, valida la identidad del pedido y permite reintentar sólo la lectura. La recompra conserva una intención explícita, bloquea el doble clic y excluye de reintentos las líneas ya confirmadas; una respuesta ambigua no se repite con otra clave. Sus precios siguen identificados como históricos, con validación vigente en el carrito. El panel incorpora breadcrumbs y cinco destinos canónicos visitados, sin identificadores privados; la comprobación transitoria oculta el contexto y la pérdida de autoridad lo purga.

Verificación del estado integrado: 169 pruebas de componentes, 25 pruebas de pedidos —incluida D1 real— y 49 de inventario/selector; tipos Worker/Nuxt/auditor, formato/lint dirigidos y compilación/política Cloudflare aprobados. El auditor real local pasa **309 escenarios y 62 migraciones**, cero llamadas salientes; confirma el detalle/listado entregado del propietario y el rechazo al usuario ajeno. Estado `passed_browser_pending`: cero escenarios de navegador ejecutados y 17 previstos pendientes, sin aceptación productiva ni CI Oracle acreditado. El selector contiene ahora 250 archivos únicos. ORD-018 pasa de no iniciado a implementación parcial **NOT_VERIFIED**, no a terminado; se mantienen 695 activos y siete descartados. Quedan en ese recorrido recuperación durable de comandos de carrito, comparación explícita de cambios y sustitutos, además de navegador/UAT. No hubo commit, push, despliegue ni operaciones en Beply.

### Recuperación de carrito, recompra vigente y actividad auditada — 8 de octubre, 18:37 UTC

El siguiente lote integra recuperación duradera de ADD en Cloudflare: recibo
autorizado de sólo lectura, journal acotado sin PII y reintento explícito con
clave, cuerpo, versión y carrito originales. Una entrega incierta bloquea otras
mutaciones, cotización, creación del pedido y pago incluso entre esperas. La
recompra compara los importes históricos con precios/IVA/límites/disponibilidad
vigentes observados, sin reservar ni prometerlos; excluye ofertas no comprables.
La actividad administrativa es independiente del historial de visitas: verifica
auditoría y comandos, filtra permisos vivos y no expone actores ni datos privados.

Verificación del lote congelado: **220 componentes en siete archivos**, **62
pruebas de ofertas/pedidos/DTO**, **85 de rutas, actividad, recibos e inventario**
y **64 de selector y contrato NOTRUN**; son bandas distintas, no un gate global.
Tipos Worker/Nuxt/auditor, formato/lint dirigidos y diff-check pasan. El build
Cloudflare y su política pasan con 7.147 entradas/880 fuentes Nitro. La auditoría
real local pasa **316 escenarios/62 migraciones**, cero llamadas salientes:
`passed_browser_pending`, cero escenarios de navegador ejecutados y **21
pendientes**, incluidos los nuevos recorridos preparados de recuperación ADD.
No se han ejecutado en remoto ni se acredita CI Oracle, UAT o producción.

El selector registra 259 archivos únicos. Se mantienen 695 requisitos activos,
siete descartados y los estados amplios: ORD-018/UI-003 continúan NOT_VERIFIED.
Sustitutos y los recorridos completos P0 siguen pendientes. La búsqueda real de
entidades del panel es el siguiente lote en desarrollo paralelo; no forma parte
de este checkpoint. Sin commit, push, deploy ni operaciones en Beply.

### Búsqueda global de entidades — 8 de octubre, 18:51 UTC

El panel Cloudflare localiza productos por nombre/SKU y pedidos por identificador
y abre sus detalles existentes. Búsqueda literal normalizada, resultados acotados
y permisos vivos por fuente; sin datos personales de compradores ni importes.
La UI requiere envío explícito, distingue fallo de vacío confirmado e invalida
resultados cuando cambian consulta, sesión o permisos. Node conserva su contrato.

El lote integrado pasa 132 pruebas de componentes, 43 de servicio/HTTP/D1 real,
18 de rutas reales y 89 de selector/inventario/helper; son bandas separadas.
Tipos Worker/Nuxt/auditor, formato/lint dirigidos, diff-check y requirements:audit
pasan. Build/política Cloudflare: 7.175 entradas y 884 fuentes Nitro. Auditoría
real local: **322 escenarios/62 migraciones**, cero llamadas externas;
`passed_browser_pending`, cero escenarios de navegador ejecutados y 21
registrados pendientes. El lock del servidor E2E estaba ocupado en la única
consulta de las 18:41 UTC; no se reservaron recursos ni se ejecutó navegador.

El selector registra 264 archivos únicos; los estados y el denominador no
cambian. UI-003 no se cierra por este bloque. El historial unificado de pedido
cliente/admin ya está en desarrollo paralelo, fuera de esta aceptación. CI
Oracle, los journeys completos, proveedores y UAT/producción siguen pendientes.
Sin commit, push, deploy ni acciones en Beply.

### Historial confirmado de pedidos — 8 de octubre, 19:19 UTC

Cliente propietario y administrador leen un historial paginado que combina siete
familias de hechos: checkout, pago, preparación, devolución, reembolso, factura y
rectificativa. La proyección verifica comandos, auditorías y recibos, vuelve a
comprobar la autoridad al finalizar y no expone motivos, actores ni datos privados.
La UI invalida lecturas al cambiar sesión, correo verificado, permisos o pedido.
Una captura local no se presenta como liquidación bancaria y los documentos de
validación local se identifican expresamente.

Checkpoint congelado: 112 pruebas de componentes, 44 de backend/HTTP/D1 y 23 del
helper; regresión dirigida de rutas, selector e inventario aprobada. Tipos
Worker/Nuxt/auditor y build/política pasan: 7.243 entradas/888 fuentes Nitro.
La auditoría real local pasa **329 escenarios/62 migraciones**, cero llamadas
externas, `passed_browser_pending`. ORD-003 continúa NOT_VERIFIED y el selector
registra 272 suites; no cambia el denominador ni se certifica producción.

Se ejecutó navegador privado real sobre el bundle anterior: la navegación de
teclado pasó, pero el header de administración desbordaba en móvil. La corrección
está compilada y sus 21 pruebas dirigidas pasan; falta repetir la comprobación
visual. Se cerraron navegador, túnel y reserva propios. La siguiente reserva fue
rechazada por estar ocupada; no se hicieron más intentos. Los 21 escenarios
registrados de navegador y CI Oracle/UAT/proveedores siguen pendientes.

El siguiente lote en desarrollo —bandeja operativa de pedidos y cancelación sin
ningún historial de pago— no forma parte de la aceptación anterior. No hubo
commit, push, despliegue ni operaciones en Beply.

### Cancelación inicial y bandeja operativa — 8 de octubre, 19:38 UTC

Cliente y administrador pueden cancelar explícitamente un pedido que nunca haya
iniciado ningún pago. Una sola transacción libera la reserva válida, cambia el
estado y conserva comando/auditoría; el historial verifica ese recibo. Los
reintentos no duplican stock ni efectos. Una respuesta incierta conserva la
intención original, bloquea operaciones competidoras y permite recuperación
manual; salir avisa de la pérdida del contexto de esa pestaña. Se actualizan
detalle, historial y lista únicamente mediante lecturas confirmadas.

La bandeja Cloudflare incorpora filtros aplicados, orden, paginación y un único
contexto de preparación gobernada. No mezcla filtros sin aplicar con la consulta
confirmada y purga también las búsquedas privadas al cambiar autoridad. Node
conserva sus páginas y flujos existentes.

El lote integrado pasa **286 pruebas de componentes en siete archivos**, **91
de servicio/HTTP/D1 en siete** y **158 de rutas/helpers/selector/inventario en
siete**; son bandas distintas, no cobertura global ni funcionalidades contadas.
Tipos Worker/Nuxt/auditor, lint/formato dirigidos, diff-check y requirements:audit
pasan. Build/política: **7.303 entradas/893 fuentes Nitro**. Auditoría real
local: **338 escenarios/62 migraciones**, cero llamadas externas; verifica
checkout HTTP sin pago, cancelación, replay, recuperación, snapshots intactos,
historial y rechazo del pago posterior. Estado `passed_browser_pending`.

La única comprobación E2E nueva, 19:34 UTC, encontró ocupado el lock compartido:
no se reservó, conectó ni reintentó. Permanecen pendientes los 21 escenarios de
navegador registrados, CI Oracle, UAT y aceptación externa. Cancelación después
de cualquier intento de pago y coordinación económica/fiscal/carrier no están
incluidas. ORD-004/005/015 continúan NOT_VERIFIED, 695 activos y siete descartados;
el selector registra 280 suites. Sin commit, push, deploy ni llamadas a Beply.

Siguiente lote activo en paralelo, **fuera de este checkpoint**: exportación
acotada de los filtros de pedidos y recorridos compilados de las nuevas
operaciones. La extracción posterior del query builder y las nuevas fuentes
de exportación aún no pertenecen al bundle ni al auditor aprobados aquí.

## Unidad de trabajo

Quince módulos agrupan todos los requisitos activos. Dentro de cada módulo se entrega una funcionalidad completa de la fase vigente —por ejemplo, importación con validación, preview, aplicación, recuperación y auditoría—, no un campo o un ID aislado. Un módulo contiene fases distintas: sus contratos de entrada deben existir, pero no necesita completar funciones de Fase 6 para habilitar la siguiente entrega Alpha.

El manifiesto `shared/functional-delivery-plan.ts` es la fuente ejecutable de pertenencia, dependencias, riesgos y suites. El selector verifica que cada ID activo pertenezca exactamente a un módulo, que las descartadas no se ejecuten, que las dependencias no tengan ciclos y que las suites seleccionadas existan. Las cifras se calculan leyendo la matriz, no copiando porcentajes a este documento.

| Módulo                      | Funcionalidad completa                                                                                | Frente habitual        |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------- |
| `catalog-content`           | Catálogo, autoría, taxonomía, publicación, importación/exportación, imágenes y documentos gobernados. | Catálogo y compra      |
| `discovery-experience`      | Búsqueda, navegación, fichas de producto y descubrimiento/SEO.                                        | Catálogo y compra      |
| `pricing-rules`             | Precios vigentes/programados/contractuales, unidades, IVA, promociones y redondeo coherente.          | Catálogo y compra      |
| `fulfillment-logistics`     | Stock del único almacén, reservas, recepción/recuentos/ajustes, preparación, recogida y envíos.       | Catálogo y compra      |
| `commerce-transactions`     | Carrito, checkout, snapshot contractual, pedido, timeline, devolución y recompra.                     | Catálogo y compra      |
| `payments-fiscal`           | Redsys, conciliación, reembolsos, Beply, facturas y rectificativas recuperables.                      | Catálogo y compra      |
| `customer-accounts`         | Identidad de cliente, datos/direcciones, autoservicio y condiciones B2B sin multisede.                | Cliente y operación    |
| `admin-publishing`          | Panel operativo, CMS, publicación, permisos por acción y UX administrativa/cliente cómoda.            | Cliente y operación    |
| `marketing-communications`  | Newsletter avanzada, consentimiento, segmentos, campañas, automatización y avisos.                    | Cliente y operación    |
| `support-crm`               | Atención experta, expedientes, conversaciones, contexto de pedidos, asignación, SLA y CRM.            | Cliente y operación    |
| `analytics-measurement`     | Eventos, privacidad, deduplicación, funnel, métricas y conciliación analítica.                        | Confianza y plataforma |
| `security-compliance`       | Sesiones, RBAC/MFA, antifraude, seguridad, privacidad, accesibilidad y cumplimiento.                  | Confianza y plataforma |
| `integrations-apis`         | APIs/contratos, outbox/inbox, Queues/Workflows y adaptadores resilientes.                             | Confianza y plataforma |
| `performance-observability` | Rendimiento, caché/CDN, logs/métricas/alertas, backups, recuperación y continuidad.                   | Confianza y plataforma |
| `quality-delivery`          | Tests multinivel, cobertura, determinismo, CI, release y aceptación operativa.                        | Confianza y plataforma |

Los frentes son capacidad de trabajo, no tres proyectos nuevos ni una jerarquía fija de agentes. Se pueden asignar dos agentes a módulos independientes del mismo frente. El principal conserva las decisiones críticas y los archivos de integración compartidos; un agente no modifica archivos que otro está editando. No se generan worktrees adicionales sólo para guardar builds o informes regenerables.

## Ciclo único por lote

1. **Preparación conjunta de pruebas.** Reunir todos los criterios de la funcionalidad y sus IDs, entradas/salidas, tablas/APIs, permisos, límites y dependencias. Seleccionar las regresiones existentes y escribir todas las nuevas pruebas previstas antes de implementar: éxito, errores, bordes, abuso, duplicados, carreras, fallo parcial/recuperación y UX aplicables. Registrar lo que necesita datos/proveedores/aceptación externos. Ejecutar una primera pasada específica y distinguir comportamiento ausente de un fixture incorrecto.
2. **Implementación continua.** Tres agentes como máximo, cada uno con un módulo o parte independiente grande y propiedad de archivos; el principal integra contratos/dependencias y hace trabajo pequeño independiente. Reutilizar las soluciones y librerías existentes. Pruebas específicas al cambiar comportamiento; no repetir formato global, typecheck Nuxt, todas las suites o build por requisito. No publicar estados parciales como funcionalidades terminadas.
3. **Congelar e integrar.** Los agentes entregan código, pruebas, resultados y pendientes; dejan de editar sus archivos. El principal revisa permisos, atomicidad, dinero/stock, recuperación, límites reales y consistencia frontend/servidor. Los tests y auditores no se relajan para conseguir verde.
4. **Validar el lote junto.** Suites afectadas y un gate local global serializado. Ante un fallo, repetir primero lo fallido; el certificado conjunto debe corresponder al estado final del código. Cambios de contratos comunes amplían la selección de regresiones. No ejecutar gates globales en paralelo desde cada agente.
5. **Cerrar evidencia y seguir.** Una entrega de funcionalidad con su diff, resultados y aceptación pendiente. Actualizar sus IDs juntos sin cerrar requisitos amplios por una subparte. Sin commits por requisito; una entrega local no implica push, despliegue, campaña, llamada a producción o autorización para emitir documentos fiscales.

Preparar «todo el testing primero» significa tener la matriz de aceptación completa desde el principio y las pruebas ejecutables del lote antes de su código. No inventar hoy cientos de tests de integraciones desconocidas ni llenar suites con placeholders. La base local ya comprobada se reutiliza; sólo se repite por una causa real o en el cierre conjunto.

## Matriz de pruebas antes del código

Para cada fila activa de la matriz, conservar `requirement`, `acceptance`, prioridad y fase. Las suites del manifiesto cubren regresiones existentes, **no demuestran por sí solas toda la aceptación futura**. Completar el diseño de casos de cada lote con estas familias según su riesgo:

| Familia                  | Casos preparados antes de implementar                                                                      | Evidencia de cierre                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Contrato/dominio         | Entradas válidas e inválidas, límites, fechas, cantidades, IVA, unidades y errores estables.               | Casos reales sobre la lógica compartida; no assertions de mera existencia.                                     |
| Persistencia             | Migración vacía/anterior, restricciones, CAS, idempotencia, rollback y conservación de histórico.          | SQLite limitada y D1/workerd nativo; el fake no prueba el runtime.                                             |
| Autoridad/abuso          | Sesión/grant/MFA/correo, revocación durante `await`, propiedad, origen, datos privados y cuerpos hostiles. | HTTP real más adversariales; no permiso inferido de un botón o fixture.                                        |
| Recuperación/integración | Duplicado, reordenación, timeout, caída parcial, resultado ambiguo, reintento y compensación.              | Adaptadores locales deterministas; aceptación externa registrada separadamente.                                |
| UI/UX                    | Carga, error frente a vacío, confirmación, comando incierto, respuesta tardía, teclado, foco y responsive. | Componentes y navegador compilado para el journey afectado, con accesibilidad.                                 |
| Transversal/release      | Cobertura/mutación, E2E/browser matrix, SEO, rendimiento, restore/rollback, legal y UAT.                   | Gates específicos existentes según riesgo y todos los obligatorios para release; no sustituidos por unitarias. |

La aceptación real de Redsys, Beply, scanner, catálogo/documentos, correo, carriers y políticas humanas permanece separada y pendiente hasta tener evidencia y autorización. `neteco.beply.es` es producción. No usar la clave local, generar facturas, enviar correos ni efectuar llamadas para dar por terminado un test local.

## Comandos y coste de validación

`npm run development:plan` lista todos los módulos con sus conteos reales, prioridades/fases y estados de evidencia. No ejecuta pruebas ni cambia archivos. `npm run development:plan -- --json` ofrece el inventario completo y las aceptaciones para preparar el lote.

```sh
# Seleccionar varios módulos; sólo muestra el plan y comandos.
npm run development:plan -- --module catalog-content --module admin-publishing

# Ejecutar las regresiones seleccionadas del lote, sin duplicarlas.
npm run development:plan -- --module catalog-content --module admin-publishing --run

# Gate conjunto local, una vez congelada la entrega.
npm run development:plan -- --gate --run
```

El runner usa ejecutables/argumentos fijos sin shell y rechaza IDs/opciones desconocidos. Deduplica archivos entre módulos, ejecuta los proyectos serialmente y se detiene ante el primer fallo. El gate reúne formato, lint, tipos Worker/Nuxt, unitarias, componentes, build Nuxt Cloudflare, dry-run Worker, política de bundle, auditoría workerd local y auditoría de requisitos de sólo lectura. No ejecuta Git, deploy real, CI remoto ni comandos arbitrarios de la matriz.

Las unitarias usan como máximo cuatro workers por ejecución; componentes y generadores/builds Nuxt no se solapan. Los pasos caros se ejecutan una vez por gate, no por módulo ni ID. Si una funcionalidad necesita además cobertura, mutación, accesibilidad manual, pruebas de contrato o UAT, éstas siguen siendo obligatorias: el gate local habitual no las declara realizadas ni habilita Alpha.

## Checkpoints históricos de desarrollo

**Catálogo completo y operación del panel:** exportación nativa completa/filtrada ya tiene evidencia local. La importación completa CSV/XLSX se desarrolla como una única funcionalidad con formato/validación, referencias reales, preview inmutable, aplicación gobernada, recuperación/reversión y auditoría; no como una promoción del import editorial de nueve columnas. Se preparan primero sus pruebas y se reutiliza el contrato completo existente de 71 columnas y ExcelJS instalado, sin añadir dependencias.

La revisión de archivo en navegador es la primera etapa de preparación de esta funcionalidad, no su resultado final: no comprueba autoridad D1, aplica precios/stock, confirma derechos ni publica. No cerrar CAT-014, ADM-018 o el CRUD amplio por tener esta etapa. La aplicación y los jobs pertenecen al mismo lote; no se sustituye su alcance por una importación reducida.

### Alcance autorizado y checkpoint — 2026-10-07

El desarrollo autorizado continúa el alcance local por módulos, empezando por la importación nativa completa, sin commits, despliegues o llamadas a producción implícitos. En el checkpoint del 7 de octubre el runtime no devolvía una goal registrada. El 8 de octubre se verifica la goal activa `termina todo pls`, con el alcance completo intacto. El principal integra las decisiones críticas y mantiene una revisión conjunta por lote, no un build o commit por requisito.

El lote de importación ya incorpora las 71 columnas, preview privado/inmutable, comprobación de referencias vivas, creación atómica de nuevos borradores, precios iniciales auditados, balances y ledger del único almacén, medios pendientes y compensación exacta de un lote no utilizado ni modificado. La aplicación acotada admite 500 registros/900.000 bytes JSON y conserva UUID/IDs legados; nunca hace upsert sobre catálogo vivo ni importa aprobaciones de publicación/scanner. La UI requiere preview y confirmación, conserva clave/cuerpo de reintento y recupera estado con GET, sin repetir escrituras automáticamente.

Este es un checkpoint local verificado, no cierre de CAT-014, ADM-018 ni del CRUD amplio. Windows/Pinggy quedó cancelado; la referencia de navegador es `/devtono/.agents/e2e-server.md`, mediante el alias SSH privado `devtono-e2e`. El runtime aislado Playwright `1.62.1` con Chromium revisión `1234` ejecutó la UI compilada contra workerd real y D1 desechable: 303 escenarios, 57 migraciones y 13 escenarios de navegador pasan, con cero solicitudes externas del Worker. No certifica producción ni todas las suites del proyecto. El resto del desarrollo local continúa.

### Jobs completos implementados — checkpoint local

La migración `0055_catalog_import_jobs.sql` y sus servicios incorporan staging privado por páginas, referencias vivas, sellado inmutable y review/diff paginado. El contrato admite hasta 25.000 registros, 1.000 páginas y 100.000.000 bytes JSON expandidos; cada página mantiene el límite acotado de 500 registros/900.000 bytes. Un job `ready` sigue siendo preparación, no aplicación ni publicación.

La migración `0056_catalog_color_pattern.sql` corrige el patrón histórico de color de 67 bytes incompatible con el límite D1 de 50 bytes para LIKE/GLOB. Conserva variantes y dependencias sin reconstruir la tabla ni desactivar claves foráneas; comprueba también la longitud en bytes para rechazar sufijos NUL.

La migración `0057_catalog_import_job_commands.sql` implementa comandos atómicos del job sellado completo, recibos duraderos privados y auditoría por entidad. Los endpoints reales son `POST /api/admin/catalog/import-jobs/:id/apply` y `POST /api/admin/catalog/import-jobs/:id/revert`: cuerpo estricto `{previewHash, reason}`, máximo 4 KiB y `Idempotency-Key` ASCII válido de hasta 200 caracteres. Sesión vigente, correo verificado, MFA, los tres permisos `catalog.write`, `administration.manage` e `inventory.write`, propiedad y CSRF se comprueban también al recuperar recibos; la cuota compartida es de 30 comandos/hora. La reversión exige el conjunto y cada campo sin cambios ni usos posteriores: compensa stock con ledger, cancela precios y retira borradores, sin borrar el histórico ni inventar aprobaciones de medios/publicación.

Evidencia dirigida: 61 pruebas de servicio más una del helper auditor pasan (62), incluidas dos regresiones de `before_state` NULL; HTTP final pasa 34 nuevas más 13 anteriores (47), con el fixture de expiración corregido, y staging pasa 30. El ciclo SQLite/D1 limitado acredita 601 filas en tres páginas, replays, propiedad, expiración/revocación, permisos, CSRF, límites y fallos. El primer congelado UI pasó 313 pruebas en seis archivos; tras las correcciones de integración y revisión visual, el archivo de comandos/integración pasa 60 pruebas (las ejecuciones se solapan, no se suman). CSV/XLSX/helpers Node pasan 57 en cuatro archivos, incluida la ventana exacta de bytes con offset no nulo, y la comparación JSON de navegador pasa cinco pruebas.

Los tipos Worker/Nuxt y el typecheck estricto del auditor Node pasan. El último build y política de bundle pasan con 6.755 entradas/845 fuentes Nitro. La auditoría definitiva real workerd pasa 303 escenarios/57 migraciones, incluidos 13 de navegador compilado (siete de importación). El navegador sube tres páginas, revisa las 2.404 entradas del diff en 97 páginas explícitas y verifica apply→respuesta perdida→GET→replay idéntico→revert tanto para el job de 601 registros como para el lote acotado. Se conservan 9.015 snapshots de auditoría del job; no se publica ni se fabrican autorizaciones de medios. Cero excepciones de navegador y cero solicitudes externas. La comprobación móvil mide el resumen interno, no sólo el ancho global recortado por el layout, y exige retirar el aviso antiguo únicamente después del GET validado.

El siguiente cierre de aquel checkpoint era validar el volumen máximo de 25.000 filas; su resultado local se recoge a continuación, sin deducirlo de las 601. Scanner/upload con autoridad real, dataset operativo, límites del servicio desplegado y UAT siguen pendientes; CAT-014/ADM-018 permanecen abiertos. La aceptación administrativa completa tampoco se recertifica por arrastre.

Los demás módulos continúan según sus contratos/prioridad en paralelo: esta ruta no es una lista de funcionalidades eliminadas ni una instrucción para detener el desarrollo al subir un contador.

### Cierre de escala y herramientas — 2026-10-08, en curso

La prueba máxima `npm run audit:catalog-import:scale` pasa el ciclo local completo: bundle con comparación exacta de sus fuentes, 57 migraciones reales y D1/workerd desechable, sin bindings remotos ni proveedores. Son 25.000 productos/variantes/medios distintos, 79 páginas y 70.631.587 bytes JSON expandidos. El rollback tardío pasa en 7,945 s, apply en 15,623 s y revert en 17,084 s; los replays exactos tardan 40/37 ms. Se verifican 375.000 snapshots, dos recibos, counters intactos, fuente staged idéntica y cero llamadas externas. El ciclo dura 217,739 s y elimina su base efímera. Los tiempos HTTP son una cota superior conservadora, no medición interna de cada batch. Los probes registran límites del emulador; `cloudLimitsAccepted` y `deployedAcceptance` permanecen falsos.

El primer ensayo detectó una subida de página de más de 30 segundos. `EXPLAIN QUERY PLAN` confirmó que las consultas de duplicados y guards elegían las entradas históricas como bucle exterior y volvían a recorrer el JSON completo. Se conserva toda la validación, pero `CROSS JOIN` fija primero la página acotada y después la búsqueda por PK completa. Tres regresiones capturan el SQL y bindings reales: fallaron antes del cambio y pasan después; staging pasa 33 pruebas.

El ensayo completo posterior subió las 79 páginas en 68,8 segundos y probó rollback de todas las entidades tras un fallo tardío, pero no aceptó apply: el guard final elegía el índice nullable de GTIN para variantes MPN-only, recorriendo todas las variantes sin GTIN por cada entrada. Una regresión del plan real falló antes del cambio; la resolución explícita de identidad/rowid evita ese índice sin cambiar las comparaciones ni depender del nombre automático del índice. Las 62 pruebas de comandos pasan en 25,3 segundos. Otro ensayo confirmó apply pero detectó listas correlacionadas reconstruidas por cada medio durante revert. Se sustituyen por búsquedas con PK completa sin retirar protecciones de uso; una regresión del SQL real falla antes y pasa después. Ambos ensayos bloqueados se interrumpieron únicamente sobre procesos identificados y eliminaron sus bases efímeras; no se presentan como éxito. El resultado completo citado arriba corresponde al ensayo posterior con las tres correcciones. El probe aislado de 101 parámetros no es concluyente: el inicial podía confundirse con profundidad de expresión y la comprobación corregida no llegó a ejecutar SQL; su runtime también quedó eliminado.

`npm run audit:catalog-file:scale` pasa por separado un XLSX real de 25.000 filas/11.253.856 bytes mediante el decoder guardado, comparando exactamente sus 1.775.000 campos, Unicode y JSON incluidos. El CSV equivalente ocupa 44.334.545 bytes y se rechaza correctamente por superar 20 MB: no se presenta como CSV válido. El ciclo tarda 76,457 s, RSS máximo 1.856.668 KiB, sólo memoria y sin llamadas externas. El primer ensayo encontró corrupción de pares sustitutos en el exporter Node ExcelJS/JSZip, no en el decoder; una reproducción de una fila falló antes del cambio. El streaming writer existente conserva el texto, metadata, cabecera congelada y celdas de texto, sin nuevas dependencias ni aumentar límites; las 27 regresiones pequeñas y el ensayo máximo pasan.

La página de productos deja de refrescar automáticamente al recibir un comando editorial, porque ese refresh invalidaba temporalmente la capability y eliminaba el recibo/clave del hijo. Pasan 52 pruebas de importación editorial, incluidas ocho de integración padre/hijo, respuestas perdidas, recuperación sólo GET y revocaciones. No se conserva una capability revocada ni se añaden escrituras automáticas.

`npm run typecheck:audit` comprueba de forma independiente los auditores/harness Node y sus imports reales, sin depender de tipos generados Nuxt. Está integrado en el gate y CI; permitió corregir once errores de tipos/uso del SDK. La regresión de herramientas/performance pasa 24 pruebas. La política del 8 de octubre exige CI/CD exclusivamente en Oracle `92.5.3.72`, Linux ARM64, con usuario/directorios y recursos aislados. Los cinco workflows conservan sus comprobaciones y eliminan runners alojados, instalación OS con sudo y triggers de PR no confiables. La etiqueta verificada obligatoria no se configura por anticipado; su etiqueta reservada de denegación nunca debe asignarse. El remote propio `neteco` apunta a `tonomolla6/neteco`; la consulta inicial confirmó acceso administrativo, cero runners y ninguna variable Actions. Después Tono autorizó preparar y registrar un runner exclusivo, como se detalla abajo. `PublicHer0/neteco-shop` es sólo fuente/referencia, nunca destino de publicación o configuración CI. No se ha realizado push ni despliegue.

El adaptador Oracle pasa 58 pruebas, rechaza hosted siempre y exige una verificación externa root-managed coincidente antes de lanzar Chromium privado. Los positivos son sintéticos, no certifican el runner ni un repositorio. `NETECO_GITHUB_REPOSITORY` debe identificar el destino propio y coincidir con workflow/manifiesto; la referencia se rechaza siempre. Las 12 pruebas de workflows ejecutan el guard Bash real con seis entornos aislados y comprueban diez jobs; ese guard de steps no sustituye la admisión externa anterior al checkout. `npm run storage:preflight` es un gate sólo lectura, sin dependencias y usable con Node 24 antes de `npm ci`: mínimos de 4 GiB/100.000 inodos, 19 pruebas y comprobación local real pasan. Los hooks de build y workflows lo exigen sin limpieza automática. Una ejecución local no sustituye el CI Oracle pendiente.

El intento de gate global del 8 de octubre pasó formato, lint y tipos Worker/Nuxt/Node, pero se interrumpió durante unitarias al agotarse el presupuesto de recursos del host compartido; no se acredita como gate aprobado. Los dos archivos con cuatro fallos pasan después sus 74 pruebas en ejecución dirigida serial (100,88 s), sin cambiar código de aplicación, expectativas ni timeouts. Ese resultado no sustituye las unitarias globales pendientes. Componentes, builds y auditoría nativa finales no llegaron a ejecutarse en ese intento. El navegador privado y su túnel propios se cerraron para liberar capacidad; no se tocaron procesos ajenos.

### Atributos tipados y runner autorizado — checkpoint 2026-10-08

La auditoría actual real workerd/Chromium compilado pasa 309 escenarios, 59 migraciones y 15 escenarios de navegador, dos de atributos tipados, con cero llamadas salientes Worker. Acredita seis tipos, histórico, filtros, pérdida de autoridad y recuperación explícita de recibos/conflictos. Los ciclos CSV/XLSX acotados preservan las 71 columnas y completan apply/replay/revert. El build final y política pasan 6.898 entradas/857 fuentes Nitro. No es un gate global ni UAT.

El ciclo nativo tipado independiente pasa 25.000 productos, 98 páginas y 87.449.224 bytes expandidos, con 150.000 valores tipados, 375.000 snapshots y dos recibos. Apply/revert: 24,482/13,631 s; replays: 14/14 ms; ciclo: 258,320 s. Hashes de origen/estado protegido y limpieza propia verificados. Los flags de aceptación alojada/desplegada siguen falsos. En cambio, el archivo tipado grande se rechaza: CSV 62.751.935 bytes supera 20 MB; XLSX 12.032.270 bytes comprimidos supera 100 MB expandidos. Salida 1 y cero filas decodificadas no son un round-trip aprobado. No extrapolar desde el XLSX anterior sin estos atributos. La UI distingue ambos presupuestos y explica partes manuales por productos completos, conservando variantes/relaciones y 71 columnas, sin prometer atomicidad entre jobs; pasan 100 pruebas dirigidas de archivo/preflight/job.

Las facetas fijas y tipadas sobre 1.000 contribuyentes pasan 42 casos de compatibilidad, escala y retirada tardía, bajo los límites D1. Comparten un último batch de once agregados sin exportar todos los IDs/filas. La prueba independiente real workerd/D1 pasa 1.500 productos, 3.000 variantes y nueve GET, 1,678–1,849 s cada uno, cero outbound y limpieza propia; acredita marca/capacidad, SKU, conteos por producto y parejas de capacidad sin cruces. La evidencia de publicación es explícitamente sintética. No acepta facetas públicas de 25k, originales R2, aprobación legal/antivirus ni concurrencia de respuesta completa. El selector de referencia nombre/SKU conserva UUID manual y pasa 31 casos de componente. Su journey compilado ya pasó en la ejecución final `45440`: 309 escenarios, 59 migraciones y 15 recorridos de navegador; búsqueda real nombre/SKU, cero GET al teclear, exactamente dos GET por búsqueda y selección pública sin intersección con la primera página privada. El helper tipado registró 799 solicitudes y cero page errors; recibo con UUID exacto. Tipos Worker/Node/Nuxt y build final pasan, política 6.905 entradas/859 fuentes Nitro; browser/túnel/base propios cerrados. En ese checkpoint seguía abierto el ABI multi-snapshot; el cambio posterior se detalla abajo. CAT-007/SEA-006 mantienen su estado.

Checkpoint posterior: la respuesta pública completa ahora usa un único batch D1 para count, página/medios elegibles, once agregados y admisión de categoría/filtros. Comparte reloj del servidor, revalida el preflight tipado y no vuelve a leer estado tras el batch. TDD RED de carreras/precios/límites y GREEN de 36 casos de productos/facetas/escala; otros 213 de facetas tipadas/publicación/medios pasan tras adaptar los hooks al snapshot completo, manteniendo guards de detalle y búsqueda. SQL máximo medido 56.535 bytes; caps D1 y página conservados. No acredita concurrencia alojada, datos comerciales ni aceptación operativa. El inventario funcional incluye ahora las tres nuevas suites de red/seccomp Oracle: 216 selectores globales, 13 de calidad, catálogo 79 y discovery 16, sin duplicados. No se sustituyen con estas pruebas el CI Oracle ni el gate global.

Con autorización explícita, `neteco-oracle-arm64-01` está registrado (ID 2) y fue observado online en el repositorio propio. Usuario `neteco-actions`, volumen físico ext4 independiente de 6 GiB y cgroups CPU 1/memoria máxima 3 GiB/swap 512 MiB/tareas 512. El probe real dentro de su misma unidad pasa 20 checks: identidad, herramientas, rutas inaccesibles, límites efectivos, TLS GitHub y conexión bloqueada a un canario vivo del host. DNS sólo del runner; SELinux Enforcing y producción intactos. Véanse detalles en `docs/testing/neteco-e2e-server.md`.

El runner permanece en cuarentena: hook externo root-managed deniega todo sin marcador de aprobación, que no existe. No se emitieron manifiesto, etiqueta de workflow ni variables Actions; no se publicaron workflows ni se ejecutó CI. Su namespace de red propio ya pasa 13 comprobaciones reales, incluidos loopback IPv4/IPv6 y sockets abstractos separados del host. Tras reproducir un canal residual del helper con un canario propio, el filtro seccomp adicional bloquea socketpair DGRAM y rutas de señales; 35 casos ARM64 pasan y el arranque real conserva el filtro. El probe real de 13 controles se repitió correctamente tras ese cambio y el runner vuelve online. Antes de admitir jobs faltan las pruebas de destinos privados/metadatos, capacidades completas de navegadores/nativos y Docker/BuildKit aislado con gate de almacenamiento, además del gate realmente ejecutado. Registro online no equivale a CI aprobado ni autoriza despliegue.

## Verificación de esta reorganización

El manifiesto/selector valida 15 módulos, 695 IDs activos asignados exactamente una vez, siete descartadas preservadas, cero aceptaciones vacías y 222 selectores existentes deduplicados. Incluye las suites tipadas/tabular, facetas fijas/escala y hook/probes/bootstrap/seccomp de red Oracle, más capability, importación OCI, gate host/datastore, CLI Docker privado y recuperación de checkout/pago: catálogo selecciona 79, discovery 16, ambos reúnen 85 únicos, comercio 19, pagos 9 y calidad 17; las veintidós pruebas del inventario/resolver real pasan tras REDs por omisión. Este inventario no ejecuta las suites seleccionadas ni acredita su resultado. Las opciones y módulos desconocidos se rechazan. Planes normales, JSON y `--gate` no ejecutan comandos hasta recibir `--run`.

Checkpoint 13:26 UTC: userspace Noble ARM64 sellado y volumen propio adicional de 16 GiB instalados. En la unidad exacta del runner pasan workerd/D1 y Chromium/Firefox/WebKit con interacción DOM real, más 35 pruebas del compilador/filtro nativo como UID980. Runner normal restaurado online/idle; sólo etiquetas automáticas y cuarentena intacta. Las nuevas suites capability/OCI pasan respectivamente 11 y 8 pruebas dirigidas; no son aceptación de aplicación ni CI Actions. Siguen pendientes contenedores privados, su gate host/datastore, destinos de red activos restantes y gate global. Detalles y límites en `docs/testing/neteco-e2e-server.md`; no se modifican estados ni porcentajes de requisitos.

Checkpoint posterior del 8 de octubre: el UID980 ya consulta exclusivamente el motor Docker rootless privado mediante CLI root-managed y socket propio; el gate de almacenamiento real pasa. El arranque de PostgreSQL falla por autodetección runc/OwnerUID bajo la visibilidad proc restringida; no se relajan esos controles y CI continúa en cuarentena. No hay evidencia de contenedores funcionales ni BuildKit. En paralelo se corrigen dos journeys completos: checkout con respuesta perdida y pago de un pedido recuperado sin intento previo. Las nuevas suites se seleccionan en comercio/pagos y se deduplican globalmente: 115 pruebas de componentes y 149 unitarias dirigidas pasan, con tipos Nuxt/auditor. Son componentes con APIs simuladas, no navegador compilado ni aceptación de proveedores. No se promueven estados de requisitos por estas subpartes.

Como baseline histórico, el primer lote bajo este flujo pasó un único gate global congelado: 5.544 unitarias/203 archivos, 1.951 componentes/53 archivos, formato/lint, tipos Worker/Nuxt, build Cloudflare y política de bundle. Aquella auditoría real workerd pasó 280 escenarios/53 migraciones, con revisión de CSV/XLSX en Chrome compilado y cero llamadas externas. No son resultados del código actual con migraciones 0055–0057. Los estados de requisitos no se inflaron: 134 con evidencia de repositorio de 695 activos (19,28 %), no preparación productiva. La aceptación completa de importación D1 sigue pendiente; el baseline certifica la reorganización y su preparación local, no toda la plataforma.

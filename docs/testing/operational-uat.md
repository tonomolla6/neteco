# UAT operativa de staging

TST-040 es una aceptación humana de la release candidata con representantes de almacén, administración y soporte. Se
ejecuta en staging antes de aumentar tráfico y no se sustituye por las suites automáticas. `warehouse`,
`administration` y `support` son responsabilidades de aceptación del negocio, no nombres de roles RBAC. Cada resultado
distingue al representante que valida (`testerId`) del operador individual autorizado que actúa en la aplicación
(`executorId`): deben ser personas distintas. Nadie comparte credenciales y esta UAT no afirma que exista una interfaz
autoservicio para cada rol.

La fuente normativa de los nueve guiones es `docs/testing/operational-uat-policy.json`. Su digest SHA-256 identifica
exactamente los criterios firmados. Se comprueba con:

```bash
npm run audit:uat:policy
```

No se versiona un manifest aprobado de ejemplo: hasta que personas reales ejecuten y firmen la UAT sobre un despliegue
real, TST-040 permanece `PARTIAL_EXTERNAL`. Está prohibido inventar identidades, resultados, defectos, firmas o
artefactos para cambiar ese estado.

## Preparación de staging

- Desplegar el SHA candidato como `APP_VERSION=<sha-de-40-caracteres>` en una URL HTTPS de staging. No usar localhost,
  dominios `.example`, producción ni una URL con credenciales.
- Usar exclusivamente catálogo, clientes, tickets, pedidos, buzones y proveedores sintéticos/sandbox. Crear referencias
  específicas de la sesión y acordar su limpieza. Nunca resetear ni sembrar una base compartida con los runners E2E.
- Preparar una identidad sintética individual con MFA para cada operador autorizado, datos para los nueve guiones,
  acceso restringido a los artefactos y representantes identificados de almacén, administración, soporte y release
  management.
- Confirmar que CI, migraciones, smoke, alertas y proveedores sandbox están verdes. El preflight hace solo GET seguros,
  verifica el SHA publicado por `/api/health/live`, PostgreSQL/Redis, catálogo, noindex y robots:

```bash
npm run uat:preflight -- \
  --base-url=https://staging.neteco.invalid \
  --production-url=https://neteco.invalid \
  --expected-commit=<sha-de-40-caracteres> \
  --output=evidence/uat/<release>/preflight.json
```

El dominio reservado del ejemplo es rechazado deliberadamente y debe reemplazarse por el staging real. Un probe fallido
devuelve código 2. El JSON resultante se incluye como artefacto `staging-preflight` después de sanearlo y calcular su
SHA-256. `APP_VERSION` debe proceder del SHA/digest inmutable de la imagen desplegada, no de una edición manual del
entorno; esa proveniencia la debe imponer la futura pipeline CIC-013. El preflight comprueba el valor servido, pero no
puede demostrar por sí solo cómo lo inyectó la plataforma.

## Ejecución por rol

Cada representante sigue, en orden, los pasos, resultados y limpieza de los tres guiones de su rol en la policy:

- Almacén: pedido/stock (`UAT-WH-001`), expedición/etiqueta/tracking (`UAT-WH-002`) y
  recogida/cancelación/devolución (`UAT-WH-003`).
- Administración: MFA y autorización (`UAT-ADM-001`), cambio reversible de catálogo/precio (`UAT-ADM-002`) y
  colas/alertas/recuperación (`UAT-ADM-003`).
- Soporte: triage/SLA (`UAT-SUP-001`), nota privada y correo sandbox (`UAT-SUP-002`) y handoff de
  devolución/reembolso/factura (`UAT-SUP-003`).

Cada resultado necesita notas y al menos un artefacto. Una captura aislada no basta cuando el criterio exige estado
final: adjuntar también la referencia saneada, export o log que permita el retest. Si un guion falla o queda bloqueado,
registrar un defecto; nunca marcarlo `pass_with_defects`, porque el contrato final solo acepta `pass`.

Para `UAT-WH-001` y para cada uno de los tres casos de `UAT-WH-003`, el operador genera la conciliación de inventario
de solo lectura durante la sesión:

```bash
APP_ENV=staging APP_VERSION=<sha-de-40-caracteres> DATABASE_URL=<conexion-staging> \
  npm run uat:inventory -- \
  --order=<referencia-publica> \
  --case=<baseline|pickup|cancellation|return> \
  --expected-commit=<sha-de-40-caracteres> \
  --output=evidence/uat/<release>/inventory-<caso>.json
```

El comando abre una transacción PostgreSQL `READ ONLY`, omite identidad, direcciones y contenido de motivos, y publica
solo referencias operativas, cantidades, movimientos, hashes de motivos y checks. Rechaza otro `APP_ENV`, un
`APP_VERSION` distinto, incoherencias o stock negativo; crea un JSON nuevo bajo `evidence/uat/` o `test-results/` y no
sobrescribe evidencia existente. El manifest referencia un artefacto `inventory-evidence` para `UAT-WH-001` y tres
para `UAT-WH-003`. El primero debe declarar `baseline`; los otros deben cubrir exactamente `pickup`, `cancellation` y
`return` sobre cuatro pedidos distintos en total. El auditor vuelve a calcular todos los checks y el stock disponible a
partir del snapshot saneado: editar `status`, `checks` o cantidades invalida el artefacto. La autenticidad de la lectura
de staging sigue respaldada por el operador y las firmas externas; el JSON no es una atestación criptográfica de la base.

## Manifest final y firmas

El manifest JSON validado por `scripts/lib/operational-uat.ts` contiene:

- `schemaVersion: 1`, `requirementId: "TST-040"` y `status: "final"`;
- `release`: ID, SHA, `environment: "staging"`, URL HTTPS real y hora de despliegue;
- `run`: inicio y fin; `participants`: IDs internos, responsabilidades y al menos un `application_operator`;
- `artifacts`: ID, tipo, almacenamiento, URI restringido e inmutable, SHA-256 y `recordedAt`. El preflight `pass` es un
  artefacto `repository` obligatorio; el auditor abre el archivo, recalcula su hash y comprueba sus cinco probes, SHA y
  origen. Hace lo mismo con cada `inventory-evidence`, que debe ser `pass`, corresponder al SHA y haberse generado
  durante la sesión;
- un `result` por cada uno de los nueve `scriptId`, con representante del área, operador autorizado, `pass`, evidencia y
  defectos;
- `defects`: severidad, estado, owner, guiones, hora de resolución y evidencia de retest posterior;
- exactamente cuatro `signoffs`: almacén, administración, soporte y release manager;
- `trafficDecision`: porcentaje actual, porcentaje superior objetivo, release manager, hora de aprobación y
  `validUntil`, como máximo siete días después de terminar la UAT.

Cada firma debe proceder de un sistema autenticado de aprobaciones y referenciar un artefacto de tipo
`approval-record`. El registro firmado incluye tanto el digest que imprime `npm run audit:uat:policy` como
`approvalPayloadDigest`. Este segundo digest liga SHA y origen de la release, sesión, participantes, evidencias no
circulares, resultados, defectos y la propuesta de tráfico (porcentaje actual, objetivo y release manager). La firma se
produce después de completar la sesión; la decisión final de tráfico, después de las cuatro firmas. El release manager
es un participante separado y debe firmar la misma propuesta que autoriza.

El auditor local comprueba identidad y hashes declarados y que ambos digests coincidan, pero no descarga el artefacto ni
inicia sesión en el sistema externo de aprobaciones. El reviewer del environment protegido debe abrir los cuatro
registros, contrastar sus identidades, contenido y hashes y rechazar el job si no son accesibles o auténticos; el
manifest por sí solo no convierte texto inventado en una firma.

Validar el manifest contra el SHA y el origen que realmente se pretende promover:

```bash
npm run audit:uat -- evidence/uat/<release>/operational-uat.json \
  --expected-commit=<sha-de-40-caracteres> \
  --expected-url=<url-https-real-de-staging> \
  --production-url=<url-https-real-de-produccion>
```

El auditor comprueba además que el commit existe y es ancestro del checkout desde el que se evalúa la evidencia, y que
policy, auditores, preflight, health y workflow no han cambiado desde ese commit. Un SHA, origen, guion, rol, artefacto,
digest, firma o secuencia temporal inconsistente bloquea el comando.

El workflow usa dos checkouts separados. Ejecuta auditores y dependencias desde el SHA candidato exacto; obtiene el
manifest y sus artefactos desde el commit que disparó el workflow, que debe ser descendiente del candidato porque esa
evidencia no podía existir antes de la UAT. El segundo checkout se usa solo como almacén de evidencia y nunca ejecuta
sus scripts.

El workflow manual `Staging operational UAT evidence check` ejecuta estos controles dentro del environment protegido
`staging`. Las URLs no son inputs libres: proceden de las variables protegidas `UAT_STAGING_URL` y
`UAT_PRODUCTION_URL`, deben ser distintas y no pueden ser IPs; el operador aporta solo el SHA y la ruta del manifest
saneado. La aprobación caducada falla. Hay dos preflights deliberadamente distintos: el `staging-preflight` del
manifest demuestra el estado antes de iniciar la sesión y el workflow crea otro después de la decisión firmada para
reconfirmar el mismo SHA/origen justo antes de usar el gate. El auditor exige que el segundo tenga menos de 15 minutos;
después genera `operational-uat-evidence.json`, que incluye explícitamente el hash del preflight de sesión y une mediante
SHA-256 el preflight actual, el manifest aprobado exacto, los digests y la decisión. Conserva durante 30 días ese índice,
el preflight actual y una copia redactada del manifest validado. Para verificar posteriormente un registro histórico sin
autorizar tráfico se puede añadir `--historical` al auditor; esta opción solo omite la caducidad y sigue exigiendo un
preflight actual posterior a la decisión.

## Defectos y gate de tráfico

- P0/P1 abiertos o con riesgo aceptado bloquean. Un defecto resuelto necesita un artefacto explícito de tipo `retest`,
  referenciado también por cada resultado afectado; una nota genérica o un approval record no sirven.
- P2/P3 pueden seguir abiertos o aceptarse solo si están explícitos, tienen owner y no convierten ningún guion en
  fallido/bloqueado.
- No ampliar tráfico con un manifest `draft`, con ejecución parcial o copiando una aprobación de otra policy/release.
- Guardar manifest y registros de aprobación de forma inmutable durante la vida de la release. Capturas o vídeos con
  datos deben quedar en almacenamiento restringido, no en artifacts públicos ni en logs del repositorio.
- Si el gate falla, mantener el porcentaje actual, corregir o revertir, repetir los guiones afectados y emitir nuevas
  firmas. Una aprobación anterior nunca se edita ni se reutiliza.

Este comando produce la decisión/evidencia de TST-040, pero por sí solo no mueve ni bloquea tráfico. Su conexión
obligatoria a un despliegue canary/blue-green pertenece a la pipeline de promoción y rollback
(CIC-013/CIC-015/CIC-016); mientras esa infraestructura externa no exista, TST-040 continúa `PARTIAL_EXTERNAL` y
release management debe exigir esta comprobación como condición manual del cambio.

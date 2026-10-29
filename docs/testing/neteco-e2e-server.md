# Navegador E2E en servidor dedicado

Desde el 4 de octubre de 2026 se utiliza el alias SSH privado `devtono-e2e`
(Ubuntu ARM64). Windows y Pinggy quedan cancelados. No se abre un endpoint
Playwright público ni se copian `.env`, claves, sesiones reales o el repositorio
completo al servidor.
La referencia compartida de acceso y capacidad es
`/devtono/.agents/e2e-server.md`; el antiguo plan Windows/Pinggy no es un
requisito vigente.

## Runtime comprobado y alcance

El runtime aislado está en
`/home/ubuntu/e2e-projects/neteco-playwright-1.62.1`, con Playwright y
playwright-core exactamente `1.62.1`. Sus navegadores propios están en
`/home/ubuntu/e2e-projects/neteco-playwright-1.62.1/browsers`:
Chromium revisión `1234`, Chrome `151.0.7922.34`. Se comprobó un lanzamiento
headless real a `about:blank` en la preparación inicial; aquella comprobación
cerró sus procesos y listeners. La auditoría definitiva workerd con UI compilada
pasa 303 escenarios/57 migraciones, incluidos 13 escenarios de Chromium remoto,
con cero solicitudes externas del Worker. Node `22.22.1` y npm `9.2` permiten ese runtime; su disponibilidad
no certifica los engines ni la suite completa del proyecto.

Las ejecuciones pesadas deben respetar el lock global
`/run/lock/beply-ai-heavy-work.lock`, con concurrencia acotada. El operador
inicia un `launchServer` efímero escuchando solamente en `127.0.0.1` del
servidor. No se instalan servicios permanentes ni se modifican SSH/firewall
como parte del journey de catálogo.

## Transporte privado y cierre seguro

El operador establece el túnel (el puerto remoto debe ser el del runtime
efímero confirmado, no un puerto supuesto):

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:39069:127.0.0.1:<puerto-remoto> devtono-e2e
```

El cliente conserva `PW_TEST_CONNECT_WS_ENDPOINT`, por ejemplo
`ws://127.0.0.1:39069/<ruta-del-launchServer>`. La ruta se obtiene del runtime
activo, no se publica ni se fija en el repositorio. El alias SSH ya usa claves
propias y verificación estricta del host; no se desactiva esa verificación.

`scripts/lib/remote-test-browser.ts` permite únicamente `connect`, con timeout
de 10 segundos y `exposeNetwork: '<loopback>'`. Exige `ws`/`wss`, hostname
`localhost` o `127.0.0.1`, puerto explícito y ausencia de credenciales, query,
fragmento o espacios. Sin endpoint válido o conexión disponible falla cerrado:
no lanza un navegador en el host compartido, no usa un endpoint público y no
registra errores del proveedor que puedan contener secretos.

Los helpers del auditor conectan el navegador remoto a un contexto con sesión
sintética y reenvían únicamente su origen `.test` al Worker desechable real.
Bloquean otras solicitudes. No son una aceptación del navegador en producción.
`browserMode: 'not-run'` registra explícitamente cero escenarios de navegador;
no equivale a passed ni declara que el servicio esté averiado.

## Comandos del proyecto

La comprobación local del contrato de conexión no lanza navegadores:

```sh
npx vitest run --project unit tests/unit/remote-test-browser.test.ts --maxWorkers=1 --no-file-parallelism
```

La suite E2E existente se inicia mediante `npm run test:e2e -- --project=chromium
--workers=1 <spec>`; prepara PostgreSQL/Redis desechables y usa
`playwright.config.ts`. Ese runner general no consume automáticamente el
contrato `connectRemoteTestBrowser`: no debe ejecutarse en el host compartido
suponiendo que el túnel impida el lanzamiento local. Su ejecución en el servidor
dedicado requiere preparar por separado los recursos y engines del proyecto.

El auditor nativo usa los helpers connect-only, con el endpoint privado ya
establecido. La compilación debe incluir la UI nueva antes de comprobarla:
el navegador contra assets antiguos no valida staging ni review nuevos.
El journey de importación comprueba preflight, preview explícito, staging
paginado, sellado y diff paginado, implementados con la migración `0055`;
un trabajo `ready` es una vista previa preparada, no una aplicación ni
publicación. La migración `0056` corrige el patrón de color para el límite
D1 de 50 bytes de LIKE/GLOB sin reconstruir variantes ni perder dependencias.

La migración `0057` y el servicio implementan aplicación/reversión atómica
del job completo. Existen `POST /api/admin/catalog/import-jobs/:id/apply` y
`POST /api/admin/catalog/import-jobs/:id/revert`, con cuerpo estricto
`{previewHash, reason}` de hasta 4 KiB y clave `Idempotency-Key` ASCII válida
de hasta 200 caracteres. Exigen sesión, correo verificado, MFA, propiedad,
CSRF y los permisos `catalog.write`, `administration.manage` e
`inventory.write`, incluso en replay; comparten cuota de 30 comandos/hora.
Los recibos duraderos son privados. La compensación exige filas y campos
exactamente sin cambios ni uso posterior; conserva auditoría, revierte stock
mediante ledger, cancela precios y retira borradores, sin publicar medios.

El checkpoint dirigido actual acredita 61 pruebas finales de servicio más una
del helper auditor (62), incluidas dos regresiones de `before_state` NULL.
HTTP final pasa 34 pruebas nuevas más 13 anteriores (47), con el fixture de
expiración corregido, y staging pasa 30. Incluyen un job de 601 filas/tres
páginas, sus replays y rechazos de seguridad. El primer congelado UI pasó 313
pruebas en seis archivos; la suite final de comandos/integración pasa 60 tras
las correcciones de recibos y revisión visual (no sumar ejecuciones solapadas).
CSV/XLSX/helpers Node pasan 57 en cuatro archivos, incluida
la ventana exacta de bytes con offset no nulo, y la comparación JSON de navegador
pasa cinco pruebas.

Tipos Worker/Nuxt y typecheck estricto del auditor Node pasan; el último build
y política de bundle pasan con 6.755 entradas/845 fuentes Nitro. La auditoría
definitiva workerd/Chromium pasa 303 escenarios/57 migraciones, incluidos 13 de
navegador: dos de analítica, cuatro de exportación y siete de importación. El
job de 601 registros se sube en tres páginas y el navegador recorre las 2.404
entradas del diff en 97 páginas explícitas. Los dos importadores nativos prueban
pérdida de respuesta, GET de estado, replay exacto y compensación; el job retiene
9.015 snapshots. El resumen móvil muestra el hash completo sin clipping y no
conserva un aviso de preparación falso después del GET aplicado/revertido.
Cero page errors y cero solicitudes externas. Las capturas están en
`test-results/native-catalog-import-browser/{desktop,mobile}.png`.

Para gates automatizados usar `CI=true NUXT_TELEMETRY_DISABLED=1
WRANGLER_SEND_METRICS=false`: evita preguntas interactivas de telemetría o
instalación automática de skills. No aceptar esas instalaciones por defecto.
Dos procesos sin TTY terminaron con SIGTERM/143 sin un error de código ni OOM
registrado; la repetición no interactiva con TTY pasó. La base efímera de la
ejecución interrumpida se retiró a la papelera recuperable. Contextos, runtime y
túnel propios se cerraron; no se interrumpieron otras sesiones.

El gate global completo de calidad no se declara cerrado. Estos resultados no
aceptan el volumen de 25.000 filas, scanner/upload con autoridad real o UAT, ni
cierran CAT-014/ADM-018.
Los resultados de 5.544 unitarias, 1.951 componentes y 280 escenarios workerd
son un baseline histórico anterior a 0055–0057, no evidencia del código actual.

## CI/CD exclusivo en Oracle (8 de octubre de 2026)

Por decisión del usuario, CI/CD sólo puede ejecutarse en runners propios del
servidor Oracle `92.5.3.72`. Se prohíben GitHub-hosted y cualquier fallback a
otro host, incluido el host compartido de desarrollo. Producción continúa en
Cloudflare; esta política no autoriza push, despliegue ni cambios remotos.

Antes de asignar etiquetas o habilitar jobs deben acreditarse runner online,
acceso al repositorio y capacidades reales ARM64: engines del proyecto,
Playwright/Chromium, workerd y dependencias nativas. También deben comprobarse
usuario y directorios dedicados, aislamiento de CPU/memoria/disco, límites de
concurrencia y limpieza de recursos propios. No se permite sudo, Docker de
producción, secretos personales ni checkouts de agentes. Los jobs no pueden
ejecutar código de forks/PR no confiables en estos runners.

El navegador de CI, cuando el runner esté verificado, debe ser efímero y
escuchar únicamente en `127.0.0.1`, con puerto asignado dinámicamente y cierre
en `finally`. El auditor hijo sigue exigiendo navegador: ni
`--without-browser`, ni endpoint público, ni lanzamiento en el host compartido
son alternativas válidas. El desarrollo privado conserva su transporte SSH
connect-only descrito arriba; esa conexión no demuestra la preparación de CI.

Los cinco workflows preparados usan `self-hosted`, `Linux`, `ARM64` y la variable
`NETECO_ORACLE_RUNNER_LABEL`, sin grupos de runners. El remote existente `neteco`
apunta a `tonomolla6/neteco`: la consulta de lectura del 8 de octubre confirmó
acceso administrativo, cero runners registrados y ninguna variable de Actions.
La consulta inicial no modificó nada; el registro autorizado posterior se describe
abajo. `PublicHer0/neteco-shop` fue sólo fuente/referencia para
clonar: no es destino y no se subirá nada allí. La variable sólo debe configurarse
con una etiqueta real después de comprobar online, acceso y capacidades; no se
ha configurado. Su fallback es la etiqueta reservada
`neteco-oracle-unverified-do-not-register`, que **nunca debe asignarse**: bloquea
la selección, no deriva trabajo a otro host. Los triggers automáticos de PR se
sustituyen por ejecución manual y push de main; las comprobaciones bloqueantes
se conservan. No ejecutar manualmente una referencia no autorizada.

Node 24 debe estar preparado en el runner. El gate sólo lectura
`node scripts/storage-preflight.ts` corre antes de dependencias/builds y también
mediante hooks npm de build: exige 4 GiB disponibles y 100.000 inodos por destino,
sin limpiar automáticamente. Chromium/Firefox/WebKit y sus bibliotecas OS deben
prepararse en el entorno aislado: el workflow no usa `sudo` ni
`playwright install --with-deps`. Los jobs heredados con servicios o builds de
contenedor requieren un daemon aislado del runner, nunca el Docker de producción;
esa capacidad sigue sin verificar y no se sustituyen sus pruebas por skips.
Antes de habilitar esos builds Docker/BuildKit hay que verificar también el gate
de almacenamiento del host y el espacio del almacenamiento real del daemon;
el gate del checkout no sustituye esa comprobación. Para los demás builds se
comprueban espacio y presupuesto de recursos. El proyecto conserva además su
preflight preventivo de espacio, sin afirmar que reserve CPU o memoria.

El adaptador `scripts/lib/oracle-shop-audit.ts`, invocado por
`scripts/run-shop-audit-ci.ts`, rechaza siempre GitHub-hosted. Sólo admite
self-hosted Linux ARM64, usuario no root y eventos `push` o `workflow_dispatch`
de `refs/heads/main`; rechaza todos los PR. Exige `NETECO_GITHUB_REPOSITORY`
explícito con formato `owner/repo`, exactamente igual a `GITHUB_REPOSITORY`
y al campo `repository` del manifiesto. Rechaza siempre la referencia
`PublicHer0/neteco-shop`, incluso si variables y manifiesto coinciden. Sin un
destino propio definido y verificado, no puede admitirse ninguna ejecución CI.
Además exige `/etc/neteco-ci/neteco-shop-runner.json`, fuera del checkout,
archivo y ancestros propiedad de root, sin enlaces simbólicos ni escritura de
grupo/otros. El operador debe emitirlo sólo después de verificar los requisitos
de infraestructura y capacidad anteriores. No se ha creado ese manifiesto.

El formato mínimo es `{version, oraclePublicIp, repository, uid, user,
runnerName, machineIdSha256, workRoot, verifiedAt, expiresAt}`: versión 1,
IP Oracle fijada, fechas ISO con verificación pasada y caducidad futura, hash
SHA-256 del machine-id local sin salto final. Se comparan uid/usuario, nombre
del runner, identidad local y rutas reales de checkout y `RUNNER_TEMP` dentro
de `workRoot`. Etiquetas y variables no sustituyen esa evidencia externa.
No copiar ni emitir un manifiesto a partir de fixtures sintéticos de unitarias.

Dos pruebas RED previas demostraron la aceptación indebida de hosted, incluso
con metadatos Oracle/ARM64 simulados. Las pruebas positivas del nuevo contrato
inyectan exclusivamente evidencia sintética y navegador simulado: comprueban
lógica, no certifican un runner ni un repositorio. `example-owned/neteco` es
sólo un nombre ficticio de fixture, no un destino real. La consulta anterior
de inventario (sin admin; API de runners 404) correspondía sólo a la referencia,
no acredita acceso a ningún destino propio ni demuestra ausencia de runners.
Una comprobación posterior sobre `tonomolla6/neteco`, no sobre la referencia,
confirmó inicialmente acceso administrativo y cero runners registrados. La
preparación autorizada posterior no acredita por sí sola el CI real.

Los resultados deben distinguir pruebas locales, comprobación de capacidad y
ejecuciones CI realmente realizadas. Acceso SSH o `about:blank` no certifican
la UI compilada ni el gate completo. Los checkpoints anteriores de este
documento no acreditan un runner CI Oracle ni una ejecución de sus workflows.

### Runner Neteco autorizado y en cuarentena — 2026-10-08

Tono autorizó explícitamente preparar y registrar el runner exclusivo. Se
verificó que el host de esta sesión es Oracle `92.5.3.72`, Oracle Linux 9.8 ARM64.
El runner oficial 2.338.0, con SHA-256 contrastado contra su release, se registró
en `tonomolla6/neteco` como `neteco-oracle-arm64-01` (ID 2). La API lo confirmó
online, sin trabajos, con las etiquetas automáticas `self-hosted`, `Linux`,
`ARM64`; no se asignó la etiqueta verificada que requieren los workflows.

Usuario exclusivo `neteco-actions` (UID 980), sin grupos privilegiados. Un archivo
físicamente reservado de 6 GiB en `/var/oled/devtono-ci/neteco-volume.img` contiene
un ext4 propio montado `nodev,nosuid` en `/var/lib/neteco-ci`. El nombre de la unidad
mount instalada es `var-lib-neteco\x2dci.mount`, no el basename descriptivo de su
fuente. Servicio `devtono-neteco-actions-runner.service`, con arranque persistente,
CPU máxima 1, memoria high/max 2/3 GiB, swap máxima 512 MiB y 512 tareas. Homes,
checkouts de agentes, Docker de producción y otros runners están ocultos;
filesystem del host sólo lectura, sin nuevas capacidades ni sudo.

El 8 de octubre a las 11:01 UTC se sustituyó temporalmente **sólo ExecStart del
propio servicio** por el probe root-managed, manteniendo sus propiedades. Pasaron
20 comprobaciones reales: identidad/Node24/ARM64/Git, rutas inaccesibles, los cinco
límites cgroup numéricos, TLS GitHub con certificado válido y bloqueo de conexión
a un canario loopback del host cuya escucha se había probado. La denegación fue
timeout, no un falso positivo por puerto cerrado. El override se retiró y el
servicio normal se restauró. Esto es validación de infraestructura, **no CI**.

El runner tiene DNS propio read-only (`1.1.1.1`, `9.9.9.9`); no se modificó el DNS
del host ni se abrió el endpoint link-local de metadatos Oracle. SELinux permanece
Enforcing; sólo se restauraron los contextos del nuevo volumen.

El hook `/usr/local/libexec/neteco-ci/job-started.sh`, root-managed y fuera del
checkout, deniega todos los jobs mientras no exista `/etc/neteco-ci/jobs-approved`.
Ese marcador **no existe**, ni el manifiesto de aceptación. Diez pruebas Bash
reales acreditan la cuarentena; no acreditan la admisión positiva. No se han creado
variables Actions, publicado workflows, disparado CI ni desplegado nada. La
fuente se conserva en `infra/oracle-runner/` y los probes en `scripts/lib/`.

El aislamiento de red de ese primer checkpoint aún compartía namespace con el
host; se amplió posteriormente como se detalla abajo. Antes de admitir jobs
siguen pendientes pruebas completas de red, navegadores y dependencias nativas,
Docker/BuildKit aislado, su gate de almacenamiento y el gate completo realmente
ejecutado. No retirar la cuarentena ni emitir manifiesto/etiqueta por arrastre de
estas comprobaciones parciales. El host E2E manual sigue separado del CI.

### Namespace y egress propios — 2026-10-08, 12:14 UTC

Una reproducción automatizada RED comprobó que el PID real del runner compartía
el namespace del host. Ahora `devtono-neteco-network.service` mantiene un anchor
privado, con PID root-managed 0600 en directorio 0700. Notifica readiness sólo
después de escribirlo: el helper no puede adelantarse a ese dato. El runner
conserva UID980, filesystem, ausencia de capacidades/sudo y límites previos,
pero utiliza `PrivateNetwork`/`JoinsNamespaceOf` y depende del helper de egress.

`devtono-neteco-egress.service` ejecuta slirp4netns 1.3.3 con host-loopback y DNS
interno desactivados, sin API de forwards ni traducción IPv6. Su cgroup filtra
redes privadas/link-local/metadatos y `92.5.3.72`; se observaron los programas BPF
adjuntos. No se modificaron interfaces, rutas, DNS ni firewall del host. La
raíz del proceso servidor es tmpfs readonly con sólo `/etc/resolv.conf` y `/run`
vacío: ningún socket de systemd/Docker, directorio personal ni FD DNS original.
La unidad deniega nuevos sockets AF_UNIX y las tres llamadas io_uring que
podrían eludir ese filtro; socketpair seguía disponible para el bootstrap TAP.
Ese primer filtro no cubría socketpair DGRAM; el cierre posterior se detalla abajo.
El helper necesita capacidades administrativas únicamente durante bootstrap;
el proceso real final conserva UID0 y **sólo NET_BIND_SERVICE** (`0x400`),
NoNewPrivs y diez filtros seccomp, sin monitor administrativo superviviente.
Esto no equivale a afirmar que todo el sistema funciona sin procesos root.

El probe en la unidad exacta, con sólo ExecStart temporalmente sustituido, pasó
13 controles reales: identidad/Node/ARM64, namespace separado, loopback propio
IPv4/IPv6 y socket abstracto utilizables, canarios host TCP4/TCP6/abstracto
inaccesibles y TLS GitHub válido. Los tres canarios tenían baseline conectado
antes **y después**; ECONNREFUSED dentro del namespace no se interpreta por sí
solo como evidencia de un puerto host vivo. Los canarios propios fueron cerrados,
override retirado y las tres unidades normales quedaron activas sin drop-ins.
Las 13 pruebas CLI y nueve de bootstrap Bash/configuración pasan localmente;
no acreditan admisión positiva ni una ejecución Actions.

Quedan pruebas activas específicas de gateway, DNS interno, metadatos,
direcciones propias/privadas e IPv4-mapped desde runner y futuros contenedores.
No existen marcador de aprobación, manifiesto, variables GitHub ni etiqueta de
workflows verificada. Tampoco hay push, CI disparado, deploy o acceso a Beply.

Preflight de capacidades: Oracle Linux 9.8 anuncia glibc 2.34, pero exporta
`_dl_find_object` y los símbolos rseq GLIBC_2.35 que necesita el workerd fijado;
`workerd --version` termina 0 en el host sin loaders alternativos. Se retira el
diagnóstico inicial de incompatibilidad basado únicamente en el número 2.34.
Esto no certifica su runtime dentro del runner ni el gate completo. Playwright
1.62.1 no soporta oficialmente Oracle Linux y el UID980 no tiene sus navegadores.
La opción a evaluar es userspace oficial Ubuntu Noble ARM64, sin cambiar glibc
ni RPMs del host. No se instaló esa imagen ni se ejecutaron sus tres motores.

Los 6 GiB actuales no acreditan espacio para dependencias, navegadores, imágenes
y artefactos además del gate de 4 GiB. Docker rootless requiere identidad/rangos
subordinados, gestor user/cgroup y socket propios en el namespace aislado; la
unidad endurecida del runner no debe relajarse para ejecutarlo. El hook actual
rechaza cualquier DOCKER_HOST/CONTEXT: permitir un socket exclusivo requerirá
un contrato fail-closed comprobado, nunca acceso al Docker de producción. La
imagen oficial Actions con sudo/docker no se admite sin esa revisión.

### Cierre focal de IPC y señales del helper — 2026-10-08

La revisión independiente encontró que `RestrictAddressFamilies` no bloquea
`socketpair(AF_UNIX, SOCK_DGRAM)`: permite `sendto` a sockets abstractos del host.
La reproducción automatizada en la misma unidad de egress, con sus filtros
efectivos, envió un datagrama a un canario propio y falló como se esperaba
(RED, 12:36:35 UTC). No se contactaron sockets ajenos. Esto demuestra el canal
residual de un helper comprometido, no una explotación directa desde un job.

El launcher root-managed `infra/oracle-runner/neteco-egress-seccomp.c` añade un
filtro AARCH64 antes del Bash fijo, sin argumentos arbitrarios ni entorno de job.
Sólo permite pares AF_UNIX STREAM con protocolo cero y flags legítimos; conserva
el bootstrap TAP y rechaza DGRAM/SEQPACKET y aliases de argumentos de 64 bits.
Bloquea llamadas de señales/ptrace/process-vm/pidfd y los comandos de ownership
de `fcntl`/`ioctl` que podrían inducir SIGIO. Se conservaron STREAM I/O,
`waitpid`, `getpid`, `F_GETFL` y `F_SETFL`. Las 35 pruebas nativas ARM64 pasan sin
skips; las pruebas de señales usan exclusivamente SELF o argumentos inválidos.
No se declara que este filtro sea un sandbox universal del kernel.

En la unidad real, el mismo canario pasó de envío permitido a `socketpairDenied`
con salida cero (GREEN, 12:42:21 UTC), manteniendo baselines conectados antes y
después. El slirp normal arranca: UID0, sólo NET_BIND_SERVICE, NoNewPrivs y once
filtros seccomp observados. El probe real del runner vuelve a pasar sus 13
controles de red con el helper nuevo; los tres canarios host siguen accesibles
desde el supervisor antes/después y terminan con exactamente dos hits cada uno.

Todos los canarios propios se cerraron verificando PID, UID y comando. Se
retiraron los overrides y los dos artefactos temporales instalados se movieron
al directorio privado recuperable `/var/tmp/neteco-egress-proof.axRI8ONX`.
Las tres unidades normales están activas, sin drop-ins; la API del repositorio
propio confirma el runner online, sin jobs y sólo etiquetas automáticas.
La cuarentena permanece: sin marcador, manifiesto, etiqueta verificada ni
variables Actions. La validación dirigida final (`97954`) pasa 85 pruebas en
seis archivos, cero skips, y tipos Worker/Node; no es el gate global ni Actions.
Los destinos privados/metadatos, navegadores, Docker aislado
y gates completos siguen pendientes. No se disparó CI, publicó código ni
desplegó; producción, Beply, firewall y DNS del host permanecen intactos.

## Checkpoint manual final de catálogo — 8 de octubre, 11:44 UTC

El bundle reconstruido pasó tipos Worker/Node/Nuxt y política con 6.905 entradas
y 859 fuentes Nitro. La ejecución `45440` pasó 309 escenarios, 59 migraciones
y 15 recorridos de Chromium, incluyendo búsqueda real de referencias por nombre
y SKU, cero GET al teclear, exactamente dos GET por búsqueda, candidatos públicos
sin intersección de primeras páginas y UUID exacto en el recibo. El helper tipado
registró 799 solicitudes de navegador y cero errores de página; todo el Worker
registró cero solicitudes salientes. El Chromium privado efímero y su túnel
fueron cerrados por PID/identidad propios confirmados; el runtime/base desechables
también se eliminaron. No se tocaron los titulares ajenos del lock global.

Una prueba independiente local workerd (`35972`) pasó 1.500 productos sintéticos,
3.000 variantes y nueve GET en 1,678–1,849 s, con respuestas de hasta 9.712 bytes,
pares de capacidad sin cruces y retirada fuera de página entre solicitudes.
Su publicación es evidencia sintética D1, no originales R2, derechos ni antivirus
reales; no acredita escala pública de 25k ni respuesta concurrente integral.
Gates dirigidos: facetas 42, preparación de archivo/job 100, selector 31 e
inventario funcional 13; no sustituyen el gate global ni el CI Oracle pendiente.

### Snapshot público completo — 8 de octubre, 12:22 UTC

El nuevo build/política pasa 6909 entradas/859 fuentes Nitro. La prueba nativa
`81239` pasa 59 migraciones, 1500 productos/3000 variantes y 20 GET: incluye
cuatro pares de HTTP/escritor D1 simultáneos, con diferencias en total, página,
precio y facetas. Sólo se observan snapshots íntegros antes/después, y cada
lectura posterior confirma la mutación terminada; restauración exacta. Queries
1,900–7,972 s en este host compartido, máximo 9717 bytes, cero outbound y cleanup
del runtime/D1 propio. No es contención alojada, carga productiva ni CI.
Pruebas dirigidas adicionales: 36 de productos/facetas/escala, 213 de
facetas tipadas/publicación/medios y 49 de hooks/probes/inventario funcional.
Los guards de detalle/búsqueda originales y todos los estados de requisitos
se conservan; no se repitió aquí la matriz completa de navegadores ni el gate global.

## Capacidad real del runner aislado — 8 de octubre, 13:26 UTC

Se añadió un volumen ext4 físicamente reservado de 16 GiB, montado nodev/nosuid
en `/var/lib/neteco-ci-runtime`. El preflight dejó al menos 12 GiB libres en el
host tras reservarlo. El volumen anterior de 6 GiB conserva runner/identidad;
el nuevo contiene rootfs, work, cache y tmp propios. No usa el Docker del host.

`scripts/lib/neteco-oracle-image-stage.sh` y su unidad operator-only importaron
como UID980 la imagen oficial Playwright 1.62.1 Noble ARM64, digest
`sha256:941cc91e5022880ac1d14ae90b476b624deb6399dbbc28d612d5d5bd7928fcbd`.
Se usó crane 0.22.1 ARM64, con SHA256 de la publicación oficial verificado.
La importación real terminó a las 13:08:44 UTC, salida cero, 34,078 s CPU y
515 MiB de memoria máxima. El tar plano mide 2.771.851.264 bytes; se conserva
como material de recuperación propio, no se reexporta sobre un stage ocupado.

La imagen carecía de compilador. Se reprodujo la ausencia con salida 1 y se
resolvieron 34 paquetes oficiales Ubuntu ARM64 desde el snapshot firmado
`20260720T000000Z`, con libc6-dev/libc-dev-bin fijadas a 2.39-0ubuntu8.7, igual
que la libc existente. La simulación confirmó cero upgrades/eliminaciones.
APT_CONFIG/sources aislados excluyeron NodeSource y hooks predeterminados;
descarga autenticada de 50,8 MB y extracción sin maintainer scripts, siempre
UID980 dentro de una unidad chroot operator-only. No es una instalación dpkg
completa: no se ejecutaron triggers ni se actualizó su estado. El SHA256 de
`/var/lib/dpkg/status` permaneció
`8078b5766181027e8963ced69fdae25bc234cbb5e8bbd6619bedefd9f9781a25`.
Sólo se añadió el enlace fijo cc→gcc; GCC 13.3.0 arranca y compila el harness.

Tras comprobar NSS local neteco-actions UID980/GID979, el rootfs se selló:
propietario root, sin escritura de grupo/otros y sin seguir symlinks. SELinux
se mantuvo Enforcing: se etiquetó únicamente el árbol propio mediante la política
existente. El `203/EXEC` inicial y la transición rpm_t de apt bajo NNP se
resolvieron en ese árbol, sin modo permisivo ni reglas globales. El tipo bin_t
temporal de apt sólo se usó durante preparación y el sellado restauró contextos.

El drop-in instalado `infra/oracle-runner/30-supported-userspace.conf` fija ese
RootDirectory, sin fallback al host. Conserva usuario, cero capacidades, NNP,
red privada, máscaras de producción y cgroups CPU1/máximo3GiB/swap512MiB/PIDs512.
Monta sólo fuentes propias: runner, work/cache/tmp, herramientas y configuración
root-managed readonly. Node es exactamente 24.18.1, no el Node integrado de la
imagen/runner. El cache de navegadores tiene enlaces a los binarios readonly y
`.links` propia writable.

Pruebas en **la unidad real del runner**, sin jobs Actions:

- RED del probe instalado: identidad/Noble/Node correctos, dependencias ausentes,
  salida 1 antes de red/navegadores.
- `npm ci --no-audit --no-fund`: salida 0, 1184 paquetes y `nuxt prepare` real,
  53,031 s CPU y memoria máxima 2 GiB. Se conservaron las restricciones de
  allow-scripts; no se aprobaron los cinco avisos pendientes automáticamente.
- GREEN a las 13:24:02: workerd/D1 crea tabla, inserta y lee Unicode; cero
  outbound Worker. Chromium 151.0.7922.34, Firefox 153.0 y WebKit 26.5 pasan
  secuencialmente título, formulario/click/DOM exactos y bloqueo externo.
  El probe cierra navegadores, servidor, runtime y base efímera; salida 0.
- La suite original `neteco-oracle-egress-seccomp.test.ts`, copiada sin cambios,
  pasa 35/35 como UID980 en Noble: compilación nativa y forks reales, cero skips.

El override de pruebas y la unidad de preparación se movieron al directorio
privado de recuperación del operador, fuera de systemd activo. La unidad normal
se restauró: a las 13:26 UTC la API propia confirma online/idle y sólo etiquetas
automáticas. Permanece el drop-in permanente de userspace soportado, no el probe.
El rootfs sigue sellado y no quedan directorios `probe-owned-*`.

Esto acredita capacidades del entorno, **no** la matriz E2E de la aplicación,
Actions, cobertura, mutación ni aceptación de producción. Antes de admitir CI
faltan Docker/BuildKit rootless privado, gate real host+datastore, las pruebas
activas restantes de destinos de red y el gate global. Marcador de aprobación,
manifiesto externo, etiqueta verificada y variables Actions siguen ausentes;
sin push/deploy ni acceso a Beply producción.

### 2026-10-08 14:08 UTC — gate de almacenamiento y motor privado, no CI admitido

El gate `scripts/lib/neteco-oracle-build-storage.mjs` se instala root-owned fuera
del checkout. Sólo admite su ruta instalada, Node 24 ARM64/Noble, UID/EUID980 y
el cgroup exacto del runner; rechaza args/env/Node overrides y ejecución por
stdin/eval. Importarlo no tiene efectos. La configuración `/etc/neteco-ci/storage.json`
es root-owned, sin symlinks ni escritura ajena, y fija los dispositivos reales.
Dos directorios **vacíos** root-owned del host y del volumen de contenedores se
montan readonly en `/run/neteco-ci-storage/{host,containers}`. Se valida identidad,
vaciedad y mountinfo RO antes de statfs; nunca se monta la raíz del host ni se
consulta Docker, escribe o limpia. Se usan bloques disponibles no reservados.

- RED unitario de presupuesto/identidad/invocación y RED adicional de stdin sin
  `-`/eval: estos últimos salían 0 sin informe; ahora fallan cerrado con JSON.
  GREEN 34/34, incluida importación sin efectos.
- RED **en la unidad real** a las 13:43:31: sin config operator, salida1
  `invalid_operator_config`. Tras config readable root-owned y binds RO, GREEN
  salida0: host14.820.253.696B y datastore9.542.967.296B disponibles a las13:46.
  Mínimos12GiB host, 4GiB+estimación2GiB datastore y100.000 inodos en cada uno.
- El hook instalado verifica rutas root-managed y ejecuta Node/ruta/estimación
  fijos; cualquier fallo deniega. Sus 13 tests pasan, con doubles explícitos
  para esa función, sin crear marcadores de aprobación ni afirmar admisión real.
  En runner2.338.0 el hook precede a pulls/builds de acciones Docker y servicios;
  las descargas/extracciones de archivos de acciones ocurren antes del hook.

Es presupuesto puntual, **no cuota ni reserva**. Los archivos físicos de volumen
limitan la escritura a almacenamiento ya reservado, pero un job todavía podría
agotar el volumen privado y bloquear Neteco; no se autoriza limpieza automática.

El motor usa `neteco-builder` UID/GID11080, nologin, sin sudo/grupo Docker root.
Se verificó libre antes de crearlo. Sus rangos subUID/subGID exclusivos son
2000000:65536; la entrada existente de otro usuario se preservó. RootlessKit,
Docker29.8.1 y herramientas provienen de los paquetes mantenidos del host,
montados individualmente RO junto a su clausura concreta de bibliotecas. No se
montan `/usr` o `/usr/lib64` completos, ni un daemon/socket de producción.
Pruebas reales de carga: Docker29.8.1, RootlessKit3.1.0, slirp4netns1.3.3 y
iptables1.8.10 arrancan en Noble. `ip` y libbpf se añadieron tras el fallo real de
bootstrap que identificó esa dependencia ausente.

La vista idmapped comparte **sólo** `/var/lib/neteco-ci-runtime/work` con el
builder, no home/instalación/credenciales del runner. RED bind ordinario:
UID separado no puede leer el archivo sintético. GREEN con util-linux2.39.3:
lectura/escritura visibles con el UID separado, source original y canario de
credencial denegados; el propietario físico sigue980/979. La dirección de la
tupla se estableció con esa prueba real. La unidad operator-only
`devtono-neteco-workspace-view.service` presenta980/979 como11080/11080; el runner
sigue viendo980/979, comprobado también tras el montaje global. No se crearon
ACLs sobre credenciales ni se cambiaron sus permisos.

`user@11080.service` es el gestor **de usuario** soportado, no un dockerd global
con `User=`. Nace en el anchor privado Neteco y una RootDirectory Noble RO,
con binds sólo de sus directorios/runtime/herramientas y workspace. PAM del host
se conserva. El binario público Noble systemd se copió root-owned al filesystem
del host y se montó individualmente RO: el nosuid del volumen impedía la
transición SELinux normal de PAM. La copia es idéntica al original; no se
relajaron flags del volumen ni SELinux. Un marcador de boot vacío/sanitizado,
condicionado al boot systemd real del host, evita exponer sus unidades/control.

Se reprodujo otro fallo: `ProtectHome=yes` ocultaba `/run/user/11080` aunque
figurara como bind. `ProtectHome=tmpfs` mantiene home/root/runtime ajenos vacíos
y readonly, permitiendo sólo el runtime privado explícito. El gestor arranca
limpio sin los overrides de diagnóstico. Tiene delegación real CPU/memory/PIDs;
no NNP ni bounding-set vacío porque sus helpers necesitan adquirir SETUID/GID.
El **runner principal no cambió**: UID980, NNP1 y capacidades efectivas0.

Un servicio efímero del gestor real (salida0,5ms) comprueba workspace legible y
cwd aislado, mientras credenciales/home del runner, sockets root Docker/containerd,
system-bus global y home/root ajenos no son legibles ni escribibles. Sólo prueba
metadatos/permisos, sin abrir secretos ni conectar servicios de producción.

El servicio de usuario Docker conserva sandbox/seccomp/disable-host-loopback.
RED: sandboxtrue es incompatible con detached-netns; se desactivó el fast path,
no el sandbox. RED posterior: API respondía pero Type=notify expiraba con
NotifyAccess=main; se restauró NotifyAccess=all del template oficial rootless.
GREEN con configuración permanente a las14:06:12: active/running, Resultsuccess
y socket privado0660 propietario11080:11080. La API por **ese socket literal**
confirma rootless/seccomp/cgroupns, driver systemd/cgroupsv2, overlayfs y data-root
propio en loop1. Cero imágenes/cero contenedores: aún no se ha probado ejecución,
pull, construcción BuildKit ni los servicios del proyecto.

Identidad real del daemon: UID host11080; su usernamespace es distinto del host
y mapea0→11080 y1..65536→2000000..2065535. Parent RootlessKit y slirp están en el
anchor Neteco; daemon/containerd en una netns hija, no la del host. Slirp tiene
NNP/seccomp activos. Los privilegios del daemon son de su usernamespace, no root
del host. Slice y gestor medidos:1CPU,2GiB memoria,256MiB swap,PIDs512. PAM elevó
el TasksMax agregado al arrancar; el operador lo fijó otra vez a512. Persistir y
verificar esa política al boot sigue pendiente; el gestor ya mantiene su techo
512 para los workloads. Logs del daemon quedan en archivo privado dentro del
volumen reservado, sin abrir journal/D-Bus global; falta política de retención.

Los overrides temporales de runner/gestor/logs se movieron recuperables al
directorio privado `operator`, fuera de systemd activo. No se han habilitado
daemon/linger para CI desatendido. El builder sólo escucha en socket privado y
**el runner aún no tiene acceso**: se conserva DOCKER_HOST vacío y bloqueo de
Docker en su servicio. Esa integración requiere aceptación específica, no un
fallback al motor root.

Regresión final local de seis suites:120/120, cero skips,4,26s; incluye gate34,
hook13, manifest19, capability11, stage8 y seccomp35. Manifiesto219 selectores,
calidad16, catálogo79, discovery16,695 activos y7 descartados intactos. La API
GitHub propia confirma runnerID2 online/idle y sólo self-hosted/Linux/ARM64.
Marcador de aprobación, manifiesto externo, etiquetas verificadas y variables
Actions ausentes. No es un resultado del pipeline ni aprobación de producción.

Pendiente antes de admitir CI: socket/CLI privado con UID980 y sin acceso al
builder D-Bus/credenciales; PostgreSQL17.6 y Redis8.2.1 reales con puertos sólo en
loopback Neteco; contenedores/mounts/cgroups, BuildKit/SBOM/Trivy/docker-save con
presupuesto simultáneo; arranque y retención durables; canarios restantes de
red; gate global y E2E de aplicación. Goal general activo, sin push/deploy ni
operaciones en Beply producción.

### Checkpoint 2026-10-08 14:43 UTC — conexión privada y fallo de contenedores identificado

El drop-in `50-private-docker.conf` añade únicamente el socket propio a
`/run/neteco-container`, grupo suplementario de servicio `neteco-builder` y
DOCKER_HOST literal. No se cambió la pertenencia permanente del usuario a grupos.
CLI y wrapper están root-managed y RO, fuera del checkout. El wrapper fija
`--host`; el CLI oficial rechaza un segundo host/contexto. No se presenta como
confinamiento universal de plugins Buildx, cuyos endpoints son independientes.
Se preservan máscaras del Docker root, homes ajenos y bus del builder. El resto
de `UnsetEnvironment` se conserva; sólo DOCKER_HOST deja de borrarse porque su
valor fijo se impone en la unidad.

Prueba en la **unidad principal real**, no nsenter simulando identidad: RED
14:25:53, salida 1 al faltar grupo 11080; GREEN 14:26:24, salida 0 como UID980,
NNP1/capEff0, socket 11080:11080/0660, Docker 29.8.1 rootless/systemd/cgroupsv2,
data-root propio. Gate real: host 14.078.914.560 bytes y contenedores 9.542.414.336,
ambos sobre sus mínimos. Instalado el hook con 31 pruebas y wrapper con 8; no se
creó aprobación. Fuentes/probes quedan en `scripts/lib/neteco-oracle-*`.

Aceptación posterior 14:32:06–18: gate antes/después de cada pull, imágenes
`postgres:17.6-alpine3.22` y `redis:8.2.1-alpine3.22` descargadas al datastore propio.
El primer create/start con CPU 0,5/memoria 256 MiB/PIDs 128 **falla antes de ejecutar
PostgreSQL**: runc 1.5.1 intenta `/run/systemd/private`. DBUS_SESSION_BUS_ADDRESS
y XDG_RUNTIME_DIR correctos ya existen en dockerd/containerd. En su usernamespace,
`busctl --user --no-pager status` sale 0 pero omite OwnerUID; `/proc/1/cgroup` y el
PID del gestor privado no son visibles. La selección de runc interpreta el fallo
como UID0; su librería también necesita OwnerUID para autenticación. No forzar
rootless ignorando errores de cgroups ni abrir el bus global.
Fuentes: [runc 1.5.1](https://github.com/opencontainers/runc/blob/v1.5.1/rootless_linux.go#L29-L44),
[cgroups 0.0.6](https://github.com/opencontainers/cgroups/blob/v0.0.6/systemd/user.go#L17-L71).

El probe registra ownership antes de start y recupera por label UUID exacta si
se pierde una respuesta; intenta limpiar todos sus IDs, verificando cada label.
En esta ejecución retiró exactamente un contenedor efímero, cero fallos; la
consulta posterior confirma cero contenedores. Las dos imágenes públicas se
conservan para el siguiente intento. No hubo datos reales de pedidos/proveedores.
No están acreditados TCP de servicios, bind desde contenedor, límites efectivos,
BuildKit, SBOM, Trivy ni docker-save.

Un candidato de vista saneada sólo cgroup, sin secretos/proc general, se probó en
una unidad propia: salida 226/NAMESPACE por permiso de mount. No fue una solución
verde. No se cambió SELinux, ProtectProc ni ninguna política global. Unidad,
vista y overrides temporales se movieron recuperables a `operator`, fuera de la
configuración activa. El listener normal queda restaurado; permanecen sólo los
drop-ins 30/40/50. Faltan también arranque/retención durables y el resto de canarios
de red; no hay etiqueta verificada ni manifiesto externo ni jobs admitidos.
Un segundo intento operator-only en el namespace del gestor tampoco pudo montar
la vista: no dejó binds activos y sus archivos se conservaron en `operator`.
El AVC del primer intento confirma `mounton` denegado por SELinux; sigue Enforcing.

Desarrollo paralelo integrado: checkout conserva payload/keys ante respuesta
perdida y recupera por GET manual; tres rechazos CF demostrablemente anteriores
a efectos permiten corregir, pero 401 ambiguo no. Pedido recuperado sin intento
de pago admite elegir tarjeta/Bizum, congelar comando y consultar antes de
reintentar. REDs reales precedieron a los cambios. Gate final dirigido: 149/149
unitarias en 7 archivos y 115/115 componentes en 5, cero skips; Nuxt/auditor tipos
pasan. Las APIs están simuladas en componentes; falta navegador compilado del
journey. El manifiesto real cuenta 222 selectores, comercio 19/pagos 9/calidad 17,
695 activos y siete descartados intactos. No se promueven requisitos, CI ni
producción por estos resultados locales.

### Checkpoint 2026-10-09 13:10 UTC — servicios privados acreditados y admisión de recursos

El gate de almacenamiento instalado coincide ahora con la fuente revisada.
Un RED contra el módulo instalado reprodujo la admisión incorrecta de 12 GiB
libres en un filesystem de 200 GiB; el GREEN conserva el 10% y carga el crecimiento
del loop sparse también a su disco físico. En la unidad real, el presupuesto de
2 GiB pasa con 28.227.809.280 bytes disponibles en raíz y 9.056.264.192 privados;
los mínimos efectivos son 21.779.342.951 y 6.442.450.944 bytes, respectivamente.

Aceptación real a las 12:49:49: PostgreSQL 17.6 y Redis 8.2.1 pasan SQL/lectura/
escritura sintética y TCP publicado exclusivamente en el loopback de Neteco.
El runtime es crun; se leen los límites efectivos del kernel de cada contenedor:
256 MiB de memoria, 128 MiB de swap, 128 PIDs y 0,5 CPU. Un bind idmapped escribe
como UID980. Probe UUID `17a61291-276d-426d-80f9-0bafdd193722`: tres contenedores
retirados, cero fallos de limpieza; la API privada posterior confirma cero
contenedores. También se retiran el fichero sintético de 15 bytes, su directorio
vacío y el override de aceptación. Las dos imágenes públicas se conservan.

`ProcSubset=pid` ocultaba `/proc/meminfo`. Se instala únicamente un bind RO del
archivo vivo a `/run/neteco-ci-resources/meminfo`, sin abrir procfs general.
El hook root-managed comprueba esa vista, RAM disponible, límites de cgroup y
swap de todos los ancestros antes del gate de disco. La prueba efectiva como
UID980 a las 13:03:19 confirma la vista RO, procfs aún restringido y el rechazo
`job_resources_cgroup`: el pico adicional presupuestado de 4 GiB no cabe en el
límite actual de 3 GiB. No se aumentan límites ni se crea aprobación. El primer
intento del harness tenía el fichero operador 0600, ilegible para UID980; se
corrige sólo su permiso a 0644 y la prueba posterior pasa. El harness y su bind
temporal se retiran; listener normal restaurado, sin `ExecStartPre` de aceptación.

El nuevo probe de red queda **sólo en fuente**, con 36 casos verdes y 15 destinos
negativos fijos. Refused/timeout son observaciones de conectividad, no prueba de
firewall ni admisión. Faltan canarios supervisados y aceptación de esa versión.
La regresión conjunta final de storage/hook/red/manifiesto pasa 274 pruebas.

Oracle sigue en cuarentena: faltan el presupuesto operativo del build, Buildx
con el mismo driver `docker-container` del workflow, BuildKit/Syft/Trivy y su DB,
build/SBOM/scan/save reales y pipeline de aplicación. Un probe reducido no
sustituirá el Dockerfile real ni se cambiará a `driver=docker` para aceptarlo.
Sin push, Actions, despliegue, proveedor real ni cambios en producción.

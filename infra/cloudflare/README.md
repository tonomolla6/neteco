# Infraestructura Cloudflare: contrato y validación local

Esta configuración describe infraestructura nueva y separada por entorno; no
adopta ni importa automáticamente los recursos de la demo reutilizada. No acredita
que exista un entorno remoto limpio ni autoriza su creación, sustitución o borrado.

## Un propietario por recurso

Terraform/OpenTofu gobierna D1, KV, R2, las dos colas y, sólo mediante opt-in, el
dominio personalizado y sus ajustes TLS/WAF/caché/Turnstile. Los nombres parten de
`neteco-iac-${environment}`. Las protecciones `prevent_destroy` no sustituyen una
revisión de cambios ni una copia de seguridad; no cubren todos los recursos.

Wrangler conserva exclusivamente el Worker y sus assets, clases y migraciones de
Durable Objects, Workflow, Cron, consumidor de cola y conexión DLQ, variables,
bindings y observabilidad. No añadir un segundo controlador Terraform para esos
objetos. Las migraciones D1 se gestionan aparte del aprovisionamiento de la base.

## Cinco archivos y contrato de entorno

- `versions.tf`: OpenTofu/Terraform compatible `>= 1.6.0, < 2.0.0`, proveedor
  Cloudflare fijado exactamente en `5.25.0` y backend HTTP sin credenciales.
- `variables.tf`: entorno explícito `preprod` o `production`, cuenta, zona, origen
  HTTPS y cuatro namespaces de rate limit distintos y asignados realmente.
- `resources.tf`: recursos de datos y colas con nombres propios del entorno.
- `edge.tf`: tráfico y controles de zona opcionales, nunca un cambio implícito de
  la zona o landing existente.
- `outputs.tf`: DTO limitado `wrangler_environment` y metadatos de ownership.

`queue_delivery_paused=true` y `attach_traffic=false` son los valores iniciales.
TLS y reglas de zona requieren `dedicated_zone_ownership_acknowledged=true` y una
revisión explícita de la zona; no usar ese reconocimiento para sobrescribir reglas
compartidas. Turnstile también es opt-in y no activa su soporte de runtime.

El generador offline `scripts/generate-shop-config.ts --environment-file ...`
consume únicamente el DTO `wrangler_environment`, validado por
`scripts/lib/cloudflare-environment-config.ts`. No acepta el estado completo ni
inventa IDs. Obtener ese output remoto corresponde a una fase autorizada posterior;
no exportar todos los outputs o el estado como si fueran el DTO.

## Validación sin backend ni API

Con binarios y mirror locales previamente verificados, configuración CLI aislada,
sin credenciales heredadas y un directorio de datos temporal privado:

```sh
tofu fmt -check -diff -no-color
tofu init -backend=false -get=false -input=false -no-color -plugin-dir=/ruta/privada/al/mirror
tofu validate -json
```

El mirror unpacked usado es
`registry.opentofu.org/cloudflare/cloudflare/5.25.0/linux_arm64`. Esta secuencia no
ejecuta `plan`, `apply`, importaciones ni acceso al backend HTTP. No confundir la
validación del esquema del proveedor con la comprobación de permisos, cuotas,
recursos remotos o viabilidad de un plan.

Evidencia local del **2026-10-10, Linux ARM64**: OpenTofu **1.10.6** y Cloudflare
**5.25.0**, ZIPs oficiales con SHA-256 verificado. El primer `fmt` detectó formato en
`variables.tf` y `outputs.tf`; tras corregirlo se observaron `fmt`, init con mirror
y `validate` satisfactorios: `valid=true`, **0 errores y 0 avisos de validación**.
Init avisó de proveedor «unauthenticated»: el mirror local no acredita verificación
de firma del registro. El lockfile conserva actualmente un hash `h1` para ARM64;
no afirmar cobertura ni validación de otras plataformas.

## Gate declarativo de CI: preparado, no ejecutado en el runner

El job `iac-validate` de `cloudflare-compat.yml` conserva Oracle ARM64, el guard
del repositorio aprobado y el preflight de almacenamiento. Ejecuta
`scripts/cloudflare-iac-check.mjs`, sin instalar herramientas, cargar credenciales,
ejecutar plan/apply ni subir estado o artefactos. Las **16 pruebas unitarias del
gate están verdes**; comprueban wiring y orquestación de rechazo/limpieza, no una
ejecución real de OpenTofu dentro del runner.

El script exige una instalación operativa futura en
`/usr/local/libexec/neteco-ci/iac`: `tofu`, `manifest.json` y el mirror del proveedor.
Verifica propietario root, ausencia de symlinks y de escritura por grupo/otros en
archivos y ancestros; contrasta las versiones fijadas, los SHA-256 oficiales de
los ZIPs y los hashes de los binarios extraídos declarados en el manifiesto
sellado. El runner no puede elegir otra toolchain mediante variables de entorno.
**Esta toolchain sellada aún no está instalada ni verificada en el runner.** La
validación local anterior no demuestra que el runner pueda acceder a esos binarios.

Cada comando requiere `unshare --user --map-root-user --net`: namespace de usuario
sin privilegios administrativos del host y namespace de red aislado. **Su
disponibilidad efectiva bajo las restricciones del runner todavía no está probada.**
Si falta esa capacidad, el gate falla; no recurre al namespace con salida pública.
El entorno del proceso se limita explícitamente, sin heredar credenciales ni
redefinir `HOME`; sólo se copian los cinco archivos Terraform a un temporal privado,
se comprueba que la fuente no cambió y se espera su limpieza antes de finalizar.

No se ha ejecutado este job CI ni se ha modificado la instalación, servicios,
cuarentena o capacidad del runner. Instalar/verificar la toolchain y probar el
aislamiento requieren una operación autorizada separada. **CIC-007 no queda
cerrado por este gate en fuente ni por sus pruebas unitarias.**

## Fase remota y recuperación: aprobación independiente

Antes de cualquier init conectado, plan o apply, preparar un backend HTTP privado
por entorno, autenticación de mínimo privilegio, endpoints de lock/unlock y cifrado
en tránsito y reposo; verificar su funcionamiento y recuperación. No guardar
credenciales, planes sensibles, `.terraform/` ni archivos de estado en Git. El
lockfile de dependencias no es un archivo de estado. Un secreto marcado sensitive
puede seguir presente en el estado, incluido el secreto calculado de Turnstile.

La fase remota necesita autorización y revisión propias: inventario y ownership
reales, conservación de datos, secretos aprobados, plan revisado y gates de recursos.
No importar automáticamente la demo, recrear una zona existente ni retirar
protecciones para forzar un cambio. Conservar backups y locks; recuperar configuración
no restaura filas D1 ni objetos R2. Aplicar migraciones hacia delante y mantener
inmutables las etiquetas DO; verificar datos y runtime antes de activar colas o tráfico.

**CIC-007 sigue incompleto**: esta evidencia local no demuestra integración CI
ejecutada, recreación remota, aceptación del entorno, despliegue ni recuperación
probada. Oracle ARM64 y la cuarentena del runner conservan sus gates y aprobaciones;
este README no autoriza jobs ni operaciones remotas.

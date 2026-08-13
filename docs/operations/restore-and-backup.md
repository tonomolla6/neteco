# Backup, restore y continuidad

## Contrato

- PostgreSQL gestionado debe mantener PITR cifrado con RPO máximo de 15 minutos y retención mínima acordada de 35 días.
- `npm run db:backup` crea un dump lógico adicional y un manifiesto con tamaño y SHA-256 en `BACKUP_DIRECTORY`. En producción ese directorio debe ser un volumen o destino offsite con versionado, retención inmutable y credenciales distintas a las de la aplicación.
- Objetos de catálogo, PDFs, configuración versionada, SBOM e imagen de contenedor deben conservarse en almacenamiento versionado. El dump de PostgreSQL no los sustituye.
- Un backup no se considera válido hasta completar un restore drill aislado y las verificaciones de integridad.

## Restore drill

1. Crear una base aislada y vacía llamada `neteco_restore_<fecha>` con credenciales de restauración temporales; nunca apuntar al clúster o nombre productivo.
2. Descargar el `.dump` y su `.dump.json`, comprobar la procedencia y ejecutar:

   ```sh
   export DATABASE_URL='postgres://.../neteco_restore_20260813'
   export RESTORE_TARGET_ENV='restore-drill'
   export RESTORE_CONFIRM='restore:<host>:neteco_restore_20260813'
   npm run db:restore -- /ruta/segura/neteco.dump
   ```

3. El comando verifica manifiesto, tamaño, SHA-256, migraciones e invariantes de inventario. Después arrancar la misma versión de aplicación contra la base restaurada y ejecutar health, login admin, búsqueda, PDP, pedido sintético sin cobro y conciliación.
4. Registrar inicio/fin, RPO observado, RTO, versión, hash, conteos, diferencias y responsable. Destruir el entorno temporal mediante el procedimiento del proveedor cuando la evidencia esté archivada.

## Restauración productiva

No está automatizada por el script para evitar un borrado accidental. Declarar incidente, congelar escrituras, conservar evidencia, elegir punto PITR, obtener doble aprobación de Operaciones y negocio, restaurar a un clúster nuevo con el proveedor, validar, cambiar tráfico, ejecutar conciliación y comunicar. Nunca hacer `--clean` directamente sobre la base activa.

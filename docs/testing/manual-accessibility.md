# Protocolo manual de accesibilidad por release mayor

TST-023 se ejecuta por una persona sobre el commit desplegado en staging antes de aceptar cada release mayor. Axe y
las pruebas funcionales deben estar verdes primero, pero no sustituyen esta sesión. El resultado se registra en un
manifest JSON, se revisa por una segunda persona y se valida con:

```bash
npm run audit:a11y:manual -- evidence/accessibility/<release>/manual-accessibility.json \
  --expected-commit=<sha-de-40-caracteres>
```

Hasta que exista un manifest `final` aprobado para la release, TST-023 permanece `PARTIAL_EXTERNAL`. No se deben
inventar resultados, identidades, capturas ni aprobaciones para satisfacer el validador.

## Preparación y matriz mínima

- Usar staging HTTPS con seed sintético, el mismo commit que se promueve y proveedores sandbox/mock.
- Registrar navegador/versión, sistema operativo, viewport, método de entrada y lector/versión. Incluir al menos un
  lector de pantalla de uso real compatible con el sistema elegido (por ejemplo NVDA + Firefox o VoiceOver + Safari).
- Crear una cuenta cliente sintética y una cuenta admin sintética con MFA. No incluir contraseñas, tokens, PII ni
  secretos en notas, vídeo o capturas.
- Recorrer inicio, catálogo, búsqueda, categoría, producto/lightbox, carrito, checkout, login/MFA, cuenta/pedido y un
  listado/formulario del panel. Probar consentimiento, navegación y filtros responsive.
- Capturar notas y evidencia reproducible; cada artefacto lleva SHA-256 y un URI estable/restringido.

## Checklist obligatorio

Cada bloque corresponde a una categoría exacta del manifest y necesita al menos un check `pass` con evidencia.

### `keyboard`

- Completar catálogo → producto → carrito → checkout sin ratón, usando Tab/Mayús+Tab, flechas, Espacio y Enter.
- Comprobar enlace “Saltar al contenido”, orden lógico, activación de controles y ausencia de trampas.
- Abrir/cerrar consentimiento, navegación, filtros y lightbox; Escape y controles visibles deben devolver el foco de
  forma predecible.

### `focus`

- Verificar indicador visible contra fondos claros/oscuros, sin quedar oculto por cabeceras sticky.
- Tras validación, navegación, cierre de diálogo y cambios de estado, confirmar que el foco se conserva o mueve al
  destino anunciado y nunca se pierde en `body`.

### `screen_reader`

- Revisar landmarks, títulos, jerarquía, nombres/estados de botones, radios, checkboxes, tablas y diálogos.
- Completar login/MFA y checkout escuchando etiquetas, ayudas, precio/IVA/envío, errores y confirmaciones dinámicas.
- Confirmar que imágenes informativas tienen alternativa útil y que decorativas no añaden ruido.

### `zoom_reflow`

- Probar 200 % y 400 % de zoom, y reflow equivalente a 320 CSS px, sin scroll bidimensional salvo tablas justificadas.
- Confirmar que contenido, foco, mensajes, navegación, diálogos, checkout y acciones del panel siguen visibles y
  operables sin solaparse ni truncarse.

### `contrast`

- Medir texto, iconos informativos, bordes/estados y foco en estado normal, hover, disabled, error y seleccionado.
- Comprobar que la información no depende solo del color y documentar herramienta/versión en el artefacto de
  contraste.

### `errors`

- Enviar login, registro, búsqueda/filtros y checkout con datos ausentes o inválidos.
- Verificar resumen/mensaje, asociación campo-error, anuncio inmediato, persistencia de datos válidos y recuperación
  sin reiniciar la tarea.

### `authentication`

- Completar login, MFA, recuperación y expiración/error de sesión solo con teclado y lector.
- Confirmar que password managers, pegado de códigos, reintentos y límites no crean una barrera inaccesible y que hay
  una salida de soporte utilizable.

## Manifest, defectos y aprobación

El JSON debe cumplir el contrato de `scripts/lib/manual-accessibility-evidence.ts`: release mayor, SHA/URL/fechas,
matriz real, checks, artefactos hasheados, defectos y aprobación. Todos los IDs referenciados deben existir. Un check
fallido, una categoría sin pass, un P0/P1 no resuelto, un defecto resuelto sin retest, un revisor inconsistente o un SHA
distinto bloquean el comando.

Los P2/P3 pueden permanecer abiertos o tener riesgo aceptado solo si el manifest los declara y el revisor los considera
fuera del criterio P0 de la release; nunca se ocultan. La persona revisora confirma integridad, reproduce una muestra y
firma después de terminar la sesión. El manifest final puede versionarse si está sanitizado; artefactos con datos o
vídeo deben permanecer en almacenamiento restringido e inmutable, referenciados por URI y hash.

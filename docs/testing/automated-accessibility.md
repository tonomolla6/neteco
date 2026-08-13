# Accesibilidad automatizada

TST-022 usa Axe sobre el DOM real que entrega Nuxt y bloquea cualquier hallazgo `serious` o `critical` de WCAG 2 A,
AA, 2.1 AA o 2.2 AA. El comando dedicado es `npm run test:a11y`; CI lo ejecuta después del E2E funcional y conserva
trace, vídeo, captura y el detalle JSON de Axe cuando falla.

## Matriz cubierta

| Superficie          | Estados automáticos                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| Plantillas públicas | Inicio, catálogo, producto y autenticación; lightbox real del producto abierto y cerrado.                     |
| Estados             | Carrito y checkout vacíos, búsqueda sin resultados, error de autenticación y validación completa de checkout. |
| Diálogos            | Consentimiento inicial/configurado, navegación móvil, lightbox y filtros de catálogo/búsqueda.                |
| Checkout            | Formulario con producto real y errores de todos los campos obligatorios.                                      |
| Área privada        | Dashboard admin con MFA, listado de productos y cuenta autenticada.                                           |

Las pruebas usan la base PostgreSQL efímera, Redis y fixtures sintéticos del runner E2E. El administrador se crea,
verifica y protege con MFA dentro del caso; no hay cuentas ni PII compartidas. El viewport móvil se fija en el propio
test para que navegación y filtros se auditen en CI aunque el gate principal ejecute Chromium desktop.

Este gate no sustituye TST-023: teclado completo, lector de pantalla, zoom/reflow, contraste visual y autenticación
asistida requieren además revisión manual por release mayor.

# Componentes críticos

`npm run test:component` monta componentes reales con el runtime Nuxt y `happy-dom`. La suite bloquea CI y no usa red externa.

La matriz TST-026 cubre:

- búsqueda: debounce, sugerencias, estado de error, `ArrowDown`, `Escape` y atributos combobox/listbox;
- filtros: selección inmutable, precio acotado y controles nativos de teclado;
- variante y quantity: selección única, `aria-pressed`, mínimo, máximo, incremento y botones deshabilitados;
- carrito: actualización, eliminación y error visible de sincronización mediante los controles usados por la página real;
- formularios: edición, submit por teclado, error visible y transición a MFA del login real;
- modales: foco inicial, ciclo `Tab`/`Shift+Tab`, configuración y cierre del consentimiento;
- tablas: loading, error, vacío, filas, select y acción de expedición en la tabla real de pedidos;
- permisos: contenido privilegiado oculto por defecto y visible solo para el rol permitido; el header usa el mismo gate para el acceso al panel.

Los componentes extraídos se consumen en sus páginas de producción, evitando tests de copias de markup. E2E sigue cubriendo la composición completa, navegación y autorización del servidor; estos component tests aíslan estados y eventos con fallos rápidos y deterministas.

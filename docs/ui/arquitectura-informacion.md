# Arquitectura de información del panel y el área de cliente — UI-001

Cubre el requisito **UI-001**, que estaba en `MISSING`: _«Investigar tareas, roles y arquitectura de
información del panel/área cliente»_.

La investigación se hizo sobre la aplicación funcionando con datos reales, no sobre el código: 38
rutas recorridas en dos viewports con tres roles de sesión. El detalle del diagnóstico está en
`auditoria-ui-ux-2026-09-01.md`; aquí queda la conclusión estructural.

---

## 1. Quién usa esto y para qué

### El cliente de NETECO

No es un consumidor. Es alguien que gestiona el suministro de un bar, un hotel, un colegio o una
nave: compra **lo mismo, cada pocas semanas**. Guantes, químicos de limpieza, celulosa.

La consecuencia de diseño es directa: su tarea dominante no es descubrir producto, es **reponer**.
La literatura del sector lo confirma —para la mayoría de compradores B2B lo más valioso es repetir
el pedido del mes pasado en treinta segundos, y tres de cada cuatro prefieren el autoservicio antes
que llamar a un comercial para una reposición.

En la versión anterior, repetir un pedido era **imposible**, y la lista de pedidos estaba la última
de once secciones.

| Tarea                        | Frecuencia | Dónde estaba                            | Dónde está ahora                       |
| ---------------------------- | ---------- | --------------------------------------- | -------------------------------------- |
| Repetir un pedido anterior   | Muy alta   | No existía                              | Acción principal del resumen           |
| Ver el estado de un pedido   | Muy alta   | Sección 11 de 11                        | Resumen + `/cuenta/pedidos`            |
| Descargar una factura        | Alta       | No expuesta (la API ya existía)         | En cada fila de pedido                 |
| Consultar/añadir direcciones | Media      | Formulario de 14 campos siempre abierto | `/cuenta/direcciones`, en diálogo      |
| Listas de reposición         | Media      | «Favoritos», al final                   | `/cuenta/favoritos`, con «añadir todo» |
| Cambiar contraseña / MFA     | Baja       | Mezclada con sesiones y perfil          | `/cuenta/seguridad`                    |
| Datos fiscales de empresa    | Muy baja   | Tercer formulario de la primera tarjeta | `/cuenta/datos`                        |
| Privacidad y avisos          | Casi nunca | Sección 8 y 9                           | `/cuenta/comunicaciones`               |

### Los perfiles del panel

Del recorrido y del modelo de datos (`roles`, `role_permissions`) se distinguen tres formas de usar
el panel, aunque hoy el producto solo implementa un rol `admin` plano:

- **Operación diaria** — despacha pedidos, resuelve devoluciones, atiende soporte. Entra muchas
  veces al día y siempre a lo mismo. Necesita saber _qué está bloqueado_.
- **Catálogo y comercial** — mantiene productos, familias, precios y contenido. Entra por campañas
  o cambios de tarifa. Necesita listados manejables y edición sin miedo.
- **Sistema** — vigila colas, conciliación, relevancia de búsqueda y flags. Entra cuando algo falla.

En la versión anterior los trece destinos estaban **al mismo nivel**, en una fila horizontal con
scroll, idéntica para todos, con «Feature flags» pesando lo mismo que «Pedidos».

---

## 2. La arquitectura resultante

### Área de cliente — de una ruta a siete

```
/cuenta                      Resumen · último pedido y su acción principal
├── /cuenta/pedidos          Historial, filtros, factura, repetir
├── /cuenta/favoritos        Listas de compra · añadir la lista entera al carrito
├── /cuenta/direcciones      Agenda · alta y edición en diálogo
├── /cuenta/datos            Contacto, email y datos fiscales de empresa
├── /cuenta/seguridad        Contraseña, verificación en dos pasos, sesiones
└── /cuenta/comunicaciones   Avisos por email y privacidad (RGPD)
```

Siete rutas, con navegación lateral persistente en escritorio y desplegable en móvil. Es
exactamente el conjunto de rutas clave que Baymard mide y que el 96 % de las tiendas no ofrece.

**Efecto medido:**

|                                    | Antes    | Ahora                            |       |
| ---------------------------------- | -------- | -------------------------------- | ----- |
| Alto de `/cuenta` en escritorio    | 3.309 px | 1.642 px                         | −50 % |
| Alto de `/cuenta` en móvil         | 5.802 px | 3.084 px                         | −47 % |
| Recursos de API por carga          | 7        | 4 en el resumen, 1–2 en el resto |       |
| Campos de contraseña en una página | 5        | 3 (seguridad) / 2 (datos)        |       |
| Formularios en una página          | 6        | 1–3, agrupados por motivo        |       |

El descenso de altura no es cosmético: cada píxel eliminado era un bloque de configuración
interponiéndose entre el cliente y su pedido.

### Panel — de trece destinos planos a tres grupos

```
OPERACIÓN          CATÁLOGO           SISTEMA
├── Hoy            ├── Productos      ├── Operaciones y colas
├── Pedidos        ├── Familias       ├── Relevancia de búsqueda
├── Devoluciones   ├── Precios        └── Feature flags
├── Soporte        ├── Medios
└── Clientes       └── Contenido
```

Navegación lateral persistente. El orden dentro de cada grupo va de más a menos frecuente.

**«Panel de administración» pasa a llamarse «Hoy»**, y deja de ser un inventario para ser una lista
de excepciones: qué está bloqueado y espera una decisión. Los datos ya los calculaba
`GET /api/admin/operations` —transferencias sin conciliar, reembolsos atascados, facturas con
incidencia, soporte fuera de plazo, envíos parados, stock incoherente, mensajes muertos, rebotes—
pero vivían enterrados en el decimotercer enlace del menú.

El inventario del catálogo (20 productos, 50 referencias, 45 familias) no desaparece: baja al pie de
la pantalla, que es donde corresponde al contexto que no exige acción.

---

## 3. Principios que quedan fijados

1. **La tarea más frecuente ocupa el mejor sitio.** Si la sección once es la que todo el mundo
   busca, la arquitectura está mal, por mucho que cada sección esté bien hecha.
2. **Una ruta, una intención.** Siete recursos de API en una pantalla significa que esa pantalla
   está haciendo siete trabajos.
3. **Un formulario largo se pide, no se impone.** El alta va en un diálogo; lo que se ve por defecto
   es la lista.
4. **El vocabulario es el del usuario.** Ningún valor de la base de datos llega a la pantalla sin
   traducir.
5. **Agrupar por trabajo, no por entidad.** «Pedidos, devoluciones y soporte» juntos porque los
   toca la misma persona el mismo día, aunque sean tres tablas distintas.

---

## 4. Lo que esta fase deja pendiente

- **Navegación por rol de verdad** (UI-003 completo): ocultar grupos según permisos requiere que la
  sesión exponga los permisos efectivos, no solo `role`. Es trabajo de servidor.
- **Paginación de servidor** (UI-005): `UiDataTable` ya tiene la interfaz (`total`, `page`,
  `@update:page`), pero los endpoints devuelven la colección entera. Hoy pagina en cliente.
- **Cuentas multiusuario de empresa**: el modelo de datos ya tiene `companies`,
  `company_members` y `company_locations`, pero el área de cliente no expone ni equipo ni
  permisos ni límites de gasto. Es la pieza B2B que más echa en falta un cliente mediano.
- **Validación con usuarios reales** (UI-014): esta arquitectura está fundamentada en el modelo de
  datos, en el recorrido de la aplicación y en investigación publicada del sector, pero **no se ha
  validado con clientes ni con el personal de almacén de NETECO**. Es el siguiente paso, y ninguna
  cantidad de análisis lo sustituye.

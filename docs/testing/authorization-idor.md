# Matriz automática de autorización e IDOR

TST-020 se ejecuta en `tests/e2e/authorization-idor.spec.ts` contra la aplicación y PostgreSQL reales del entorno E2E.
Los sujetos y recursos son sintéticos y deterministas; ninguna comprobación depende de datos preexistentes ni de una
red externa.

## Fronteras cubiertas

| Sujeto                   | Recurso o acción                                                                                                  | Resultado exigido                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Anónimo                  | dirección, exportación de privacidad, retry de factura, label PDF                                                 | `401`                                                       |
| Cliente B                | dirección, sesión, pedido y exportación del cliente/empresa A                                                     | `404`, sin revelar existencia ni modificar A                |
| Cliente B                | pedido e invoice PDF con identificador inventado                                                                  | `404`                                                       |
| Miembro `buyer`          | modificación fiscal de su empresa                                                                                 | `403`; solo `company_admin` puede modificarla               |
| Miembro con MFA, sin rol | pedido ajeno, upload de catálogo y conciliación financiera                                                        | `404`/`403`                                                 |
| `support` con MFA        | lectura de pedido de la tienda; retry de factura                                                                  | `200`; `403`                                                |
| `warehouse` con MFA      | lectura de pedido de la tienda; acción administrativa                                                             | `200`; `403`                                                |
| `finance` con MFA        | lectura y retry de factura pendiente; aprobación de media                                                         | `200`/`409`; `403`                                          |
| Administrador con MFA    | gestión explícita de una empresa ajena                                                                            | permitida y auditada                                        |
| Administrador con MFA    | empresa, pedido/cancelación, devolución/reembolso, factura, movimiento bancario, media, outbox y label inventados | `404`/estado no reintentable, sin efectos                   |
| Administrador con MFA    | upload incompleto                                                                                                 | atraviesa autorización pero falla `400`, sin crear asset    |
| Administrador con MFA    | exportación privada de otro cliente                                                                               | `404`; el rol global no concede acceso a la PII del cliente |

`company_members.role` limita acciones del tenant B2B; no convierte a un comprador en personal de NETECO. En este
despliegue los roles internos `support`, `warehouse` y `finance` tienen scope explícito de toda la tienda y la matriz
confirma sus límites funcionales. El administrador no hereda acceso a exportaciones privadas del cliente.

La prueba compara las filas completas de dirección, exportación y empresa de A, la revocación de su sesión, assets
atribuidos al actor y reembolsos ligados al retorno inventado. Auditoría y outbox se consultan por un correlation ID
único de cada bloque, por lo que el gate sigue siendo determinista aunque otros specs escriban en la misma base en
paralelo. También verifica la fila de auditoría del cambio administrativo permitido.

`authenticated-purchase.spec.ts` aporta además el caso positivo real A/B de pedido e invoice PDF, incluido el intento
con cookies de invitado revocadas; `bank-transfer.spec.ts` aporta la acción financiera positiva con MFA y permiso. La
suite dedicada no repite esos journeys costosos.

## Gate

El spec forma parte del descubrimiento normal de Playwright y, por tanto, del job E2E Chromium de CI. Cualquier cambio
de autorización, ownership, MFA o código de estado en estos endpoints rompe el gate. Al añadir un endpoint que lea PII,
entregue un documento o ejecute una mutación administrativa/financiera, debe añadirse su fila a esta matriz.

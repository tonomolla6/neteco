# Arquitectura de URL e indexación

| Tipo                           | Patrón canónico              | Indexación                                | Caché pública     |
| ------------------------------ | ---------------------------- | ----------------------------------------- | ----------------- |
| Home                           | `/`                          | index                                     | SWR 5 min         |
| Catálogo                       | `/catalogo?page=N`           | index; canonical conserva página          | SWR 2 min         |
| Categoría                      | `/categoria/{slug}?page=N`   | index; facetas no allowlisted son noindex | SWR 2 min         |
| Producto                       | `/producto/{slug}`           | index solo si publicado y completo        | SWR 2 min         |
| Marca                          | `/marca/{slug}`              | index con contenido propio                | SWR 5 min         |
| Sector                         | `/sector/{slug}`             | index con contenido útil                  | SWR 5 min         |
| Necesidad                      | `/solucion/{slug}`           | index con contenido útil                  | SWR 5 min         |
| Recursos                       | `/recursos/{slug}`           | index si publicado                        | SWR 10 min        |
| Ayuda/legal                    | `/{slug-estable}`            | index salvo preferencias privadas         | SWR 10 min        |
| Búsqueda                       | `/buscar?q=`                 | noindex, follow                           | 30 s              |
| Carrito/checkout/cuenta/pedido | rutas actuales               | noindex                                   | private, no-store |
| Panel/API                      | `/admin/**`, `/api/admin/**` | noindex + autenticación                   | private, no-store |

Un cambio de slug crea un redirect 301 desde el valor anterior. Los slugs nunca identifican relaciones internas. Parámetros UTM se eliminan del canonical. Ordenación y facetas permanecen noindex salvo landing allowlisted, con contenido y demanda aprobados. Preview/demo/staging requieren autenticación y envían `X-Robots-Tag: noindex`.

# Mapa legal, de producto y tratamientos

Este documento es una especificación técnica y no sustituye la aprobación de asesoría.

## Alcance a revisar antes de producción

| Eje        | Casos                                                       | Evidencia requerida                                                       |
| ---------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| Cliente    | invitado, consumidor, autónomo, empresa/sede                | términos/versiones, identidad y reglas B2B/B2C                            |
| Territorio | España peninsular inicial; islas/internacional desactivados | IVA, consumo, entrega, devolución y restricciones                         |
| Producto   | químico, biocida, EPI, alimentario, eléctrico, packaging    | fabricante, identificador, claims, CE/DoC, CLP/UFI/SDS, ADR según aplique |
| Canal      | web, email, teléfono; WhatsApp/SMS desactivados             | base, consentimiento, plantilla, retención y proveedor                    |
| Fiscal     | tarjeta/Bizum, transferencia, reembolso, rectificativa      | series, fecha, impuestos, conservación y confirmación Beply/asesoría      |

## Registro de tratamientos

| Finalidad      | Datos mínimos                              | Base propuesta                 | Destinatarios                 | Retención técnica                           |
| -------------- | ------------------------------------------ | ------------------------------ | ----------------------------- | ------------------------------------------- |
| Compra/entrega | identidad, contacto, dirección, pedido     | contrato                       | hosting, carrier, soporte     | política fiscal/contractual aprobada        |
| Pago           | referencia, importe, estado                | contrato/interés antifraude    | Redsys                        | eventos sin datos de tarjeta según política |
| Factura        | NIF, razón social, dirección, líneas       | obligación legal/contrato      | Beply, asesoría               | plazo fiscal aprobado                       |
| Cuenta         | email, hash, sesiones, preferencias        | contrato/consentimiento        | hosting/email                 | hasta baja + ventanas de seguridad          |
| Soporte        | contacto, ticket, pedido y mensajes        | contrato/interés legítimo      | soporte/proveedores escalados | SLA + plazo aprobado                        |
| Marketing      | email, finalidad, consentimiento, campañas | consentimiento o base validada | ESP marketing separado        | hasta retirada + suppression mínima         |
| Analítica      | ID pseudónimo, eventos sin PII             | consentimiento cuando proceda  | analítica                     | ventana agregada aprobada                   |

Derechos, retención, legal hold, exportación y anonimización se implementan como workflows auditados. Producción requiere DPA, transferencias, textos legales, CMP, accesibilidad y revisión de producto firmados.

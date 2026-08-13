# Feed de Merchant Center

La fuente contractual es `GET /feeds/google-merchant.xml`. Solo exporta variantes publicadas cuya imagen principal está aprobada y limpia. El ID `neteco_<UUID de variante>` es estable; URL, referencia, identificador, precio bruto y disponibilidad salen de las mismas tablas que storefront y checkout.

`shipping_label` identifica el perfil logístico (`parcel`, `pallet`, `adr`, etc.) y `return_policy_label` usa `neteco-standard`. Antes de activar el feed, Operaciones debe configurar en Merchant Center las tarifas por CP/peso/etiqueta y la política de devolución con los mismos valores contractuales. No se publica un precio de envío ficticio en XML porque la tarifa depende de destino, cantidad y carrier.

La activación productiva requiere guardar evidencia del diagnóstico de Merchant Center, owner y fecha de revisión. Un rechazo por precio, disponibilidad, imagen, envío o devoluciones bloquea la campaña hasta reconciliar la discrepancia con la fuente contractual.

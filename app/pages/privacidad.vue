<script setup lang="ts">
const { terms, email } = useCommercialTerms()
const rightsEmail = computed(() => terms.value.dpoEmail || email.value)

const sections = [
  { id: 'responsable', title: 'Responsable del tratamiento' },
  { id: 'finalidades', title: 'Para qué usamos tus datos' },
  { id: 'datos', title: 'Qué datos tratamos' },
  { id: 'destinatarios', title: 'Quién recibe los datos' },
  { id: 'transferencias', title: 'Transferencias fuera del EEE' },
  { id: 'derechos', title: 'Tus derechos' },
  { id: 'reclamacion', title: 'Reclamar ante la AEPD' },
  { id: 'seguridad', title: 'Seguridad y menores' },
  { id: 'cambios', title: 'Cambios en esta política' }
]

const purposes = [
  {
    purpose: 'Tramitar tus pedidos: cobro, preparación, entrega, factura, devoluciones y garantía.',
    basis: 'Ejecución del contrato de compraventa (art. 6.1.b RGPD).',
    retention:
      'Mientras dure el pedido. Después, bloqueados durante seis años para atender obligaciones mercantiles (art. 30 del Código de Comercio) y los plazos de reclamación.'
  },
  {
    purpose: 'Crear y mantener tu cuenta de cliente, tus listas y tu historial de compras.',
    basis: 'Ejecución del contrato de cuenta que aceptas al registrarte (art. 6.1.b RGPD).',
    retention:
      'Mientras la cuenta esté abierta. Al cerrarla, solo se conserva lo necesario para obligaciones legales, bloqueado.'
  },
  {
    purpose: 'Llevar la contabilidad, emitir facturas y cumplir con Hacienda y otras autoridades.',
    basis: 'Obligación legal (art. 6.1.c RGPD): normativa fiscal, mercantil y de facturación.',
    retention: 'Seis años desde el cierre del ejercicio, o el plazo mayor que fije la ley fiscal.'
  },
  {
    purpose: 'Responder a tus consultas por formulario, correo, teléfono o chat, y gestionar incidencias.',
    basis:
      'Ejecución del contrato o medidas precontractuales si la consulta es sobre un pedido o un presupuesto (art. 6.1.b RGPD); en otro caso, interés legítimo en atenderte (art. 6.1.f RGPD).',
    retention:
      'Mientras se resuelve la consulta y, después, bloqueados el tiempo en que puedan derivarse responsabilidades.'
  },
  {
    purpose: 'Estudiar solicitudes de cuenta de empresa, precios pactados y pago aplazado.',
    basis: 'Medidas precontractuales a petición de la empresa (art. 6.1.b RGPD).',
    retention: 'Mientras se estudia la solicitud y, si se aprueba, mientras dure la relación comercial.'
  },
  {
    purpose: 'Tratar los datos de contacto de las personas que trabajan en empresas clientes o proveedoras.',
    basis: 'Interés legítimo en mantener la relación con la empresa (art. 6.1.f RGPD y art. 19 LOPDGDD).',
    retention: 'Mientras dure la relación con la empresa o hasta que la persona deje de ser su contacto.'
  },
  {
    purpose: 'Avisarte si un producto que compraste es objeto de un aviso de seguridad o de una retirada.',
    basis: 'Obligación legal (art. 6.1.c RGPD) derivada de la normativa de seguridad de los productos.',
    retention: 'El tiempo que conservamos los datos del pedido.'
  },
  {
    purpose: 'Enviarte el boletín y comunicaciones comerciales por correo electrónico.',
    basis:
      'Consentimiento (art. 6.1.a RGPD y art. 21 LSSI-CE), que confirmas desde el enlace que te enviamos y puedes retirar en cada envío.',
    retention: 'Hasta que te des de baja. La prueba del consentimiento se guarda bloqueada mientras pueda reclamarse.'
  },
  {
    purpose: 'Pedirte tu opinión sobre una entrega o una consulta atendida.',
    basis: 'Interés legítimo en mejorar el servicio (art. 6.1.f RGPD). Puedes oponerte en cualquier encuesta.',
    retention: 'Las respuestas se conservan de forma agregada; el vínculo con tu pedido, el tiempo mínimo necesario.'
  },
  {
    purpose: 'Medir el uso de la tienda para detectar errores y mejorarla.',
    basis: 'Consentimiento (art. 6.1.a RGPD), que das o retiras en el gestor de cookies.',
    retention: 'El identificador de medición dura como máximo 180 días y se borra al retirar el consentimiento.'
  },
  {
    purpose: 'Proteger la tienda y las cuentas frente a accesos indebidos, fraude y abusos.',
    basis: 'Interés legítimo en la seguridad del servicio y en prevenir el fraude (art. 6.1.f RGPD).',
    retention: 'El tiempo imprescindible para investigar cada incidente y, en su caso, defender reclamaciones.'
  }
]
</script>

<template>
  <LegalDocument path="/privacidad" :sections="sections">
    <template #intro>
      <p>
        Cómo tratamos tus datos personales cuando visitas la tienda, compras o hablas con nosotros, según el Reglamento
        (UE) 2016/679 (RGPD) y la Ley Orgánica 3/2018 de protección de datos personales y garantía de los derechos
        digitales (LOPDGDD).
      </p>
    </template>

    <section id="responsable">
      <h2>Responsable del tratamiento</h2>
      <p>
        El responsable es
        <LegalDatum :value="terms.companyLegalName" label="razón social">el titular de la tienda</LegalDatum>, con NIF
        <LegalDatum :value="terms.companyTaxId" label="NIF">indicado en el aviso legal</LegalDatum> y domicilio en
        <LegalDatum :value="terms.companyAddress" label="domicilio">la dirección indicada en el aviso legal</LegalDatum
        >. Para cualquier cuestión de privacidad, escríbenos a <a :href="`mailto:${rightsEmail}`">{{ rightsEmail }}</a
        >.
      </p>
      <p v-if="terms.dpoEmail">
        Delegado de protección de datos: <a :href="`mailto:${terms.dpoEmail}`">{{ terms.dpoEmail }}</a
        >.
      </p>
      <p>Tienes el resto de datos de identificación en el <NuxtLink to="/aviso-legal">aviso legal</NuxtLink>.</p>
    </section>

    <section id="finalidades">
      <h2>Para qué usamos tus datos</h2>
      <p>
        Cada finalidad tiene su base jurídica y su plazo. Cuando un plazo termina, los datos se bloquean (solo quedan a
        disposición de jueces, tribunales y autoridades, como exige el art. 32 LOPDGDD) y después se suprimen.
      </p>
      <div class="legal-table">
        <table>
          <thead>
            <tr>
              <th scope="col">Finalidad</th>
              <th scope="col">Base jurídica</th>
              <th scope="col">Plazo de conservación</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in purposes" :key="row.purpose">
              <td>{{ row.purpose }}</td>
              <td>{{ row.basis }}</td>
              <td>{{ row.retention }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        No tomamos decisiones basadas únicamente en tratamientos automatizados que produzcan efectos jurídicos sobre ti
        o te afecten de forma similar.
      </p>
    </section>

    <section id="datos">
      <h2>Qué datos tratamos</h2>
      <ul>
        <li>Identificación y contacto: nombre, correo electrónico, teléfono y direcciones de entrega y facturación.</li>
        <li>Datos fiscales: NIF y razón social cuando pides factura a nombre de una empresa.</li>
        <li>
          Datos del pedido: productos, importes, forma de pago y estado. No guardamos los datos completos de tu tarjeta:
          los trata directamente la pasarela de pago.
        </li>
        <li>Comunicaciones contigo: consultas, incidencias, devoluciones y valoraciones.</li>
        <li>Datos técnicos: dirección IP, navegador y registros de acceso, por seguridad.</li>
      </ul>
      <p>
        Los campos marcados como obligatorios en cada formulario son necesarios para tramitar lo que pides; sin ellos no
        podemos hacerlo. Si nos das datos de otra persona, por ejemplo quien recibe el pedido, debes haberla informado
        antes.
      </p>
    </section>

    <section id="destinatarios">
      <h2>Quién recibe los datos</h2>
      <p>
        No vendemos tus datos. Los comunicamos solo a quien los necesita para prestar el servicio, y siempre con un
        contrato de encargado del tratamiento (art. 28 RGPD) o por obligación legal:
      </p>
      <ul>
        <li>
          <strong>Entidad bancaria y pasarela de pago</strong>, que cobran el pedido con tarjeta o Bizum y aplican sus
          controles antifraude.
        </li>
        <li>
          <strong>Proveedor del programa de gestión y facturación (ERP)</strong>, donde se registran los pedidos y se
          emiten las facturas.
        </li>
        <li>
          <strong>Empresas de transporte y mensajería</strong>, cuando el pedido no lo entregamos con nuestro reparto
          propio: reciben el nombre, la dirección y el teléfono de entrega.
        </li>
        <li>
          <strong>Proveedor de correo electrónico</strong>, que envía las confirmaciones de pedido, los avisos de la
          cuenta y, si lo has pedido, el boletín.
        </li>
        <li><strong>Proveedor del chat de atención</strong>, cuando el chat está activo en la web y lo usas.</li>
        <li><strong>Proveedores de alojamiento, infraestructura y seguridad</strong> del sitio web.</li>
        <li>
          <strong>Administraciones públicas, juzgados y tribunales</strong>, cuando una ley lo exige, como la Agencia
          Tributaria para la facturación.
        </li>
      </ul>
    </section>

    <section id="transferencias">
      <h2>Transferencias fuera del EEE</h2>
      <p>
        Preferimos proveedores que tratan los datos dentro del Espacio Económico Europeo (EEE). Si alguno los trata
        fuera, lo hace con una decisión de adecuación de la Comisión Europea o con cláusulas contractuales tipo y las
        medidas adicionales necesarias (arts. 45 y 46 RGPD). Puedes pedirnos información sobre esas garantías en
        <a :href="`mailto:${rightsEmail}`">{{ rightsEmail }}</a
        >.
      </p>
    </section>

    <section id="derechos">
      <h2>Tus derechos</h2>
      <p>Puedes ejercer en cualquier momento, sin coste, estos derechos:</p>
      <ul>
        <li><strong>Acceso</strong>: saber qué datos tuyos tratamos.</li>
        <li><strong>Rectificación</strong>: corregir datos inexactos o incompletos.</li>
        <li><strong>Supresión</strong>: pedir que borremos tus datos cuando ya no sean necesarios.</li>
        <li><strong>Limitación</strong>: pedir que dejemos de usarlos mientras se resuelve una reclamación.</li>
        <li>
          <strong>Oposición</strong>: oponerte a los tratamientos basados en interés legítimo y, siempre, a las
          comunicaciones comerciales.
        </li>
        <li><strong>Portabilidad</strong>: recibir los datos que nos diste en un formato de uso común.</li>
        <li>
          <strong>Retirar el consentimiento</strong> que hayas dado, sin que afecte a lo tratado antes de retirarlo.
        </li>
      </ul>
      <p>
        Escríbenos a <a :href="`mailto:${rightsEmail}`">{{ rightsEmail }}</a> indicando qué derecho ejerces. Si no
        podemos identificarte con los datos que ya tenemos, te pediremos lo mínimo para comprobar que eres tú. Si tienes
        cuenta, también puedes descargar tus datos o pedir el cierre desde
        <NuxtLink to="/cuenta/privacidad">Mi cuenta, Privacidad</NuxtLink>. Respondemos en el plazo de un mes, que puede
        ampliarse dos meses más en casos complejos; si es así, te avisamos dentro del primer mes.
      </p>
    </section>

    <section id="reclamacion">
      <h2>Reclamar ante la Agencia Española de Protección de Datos</h2>
      <p>
        Si crees que no hemos tratado bien tus datos o no hemos atendido tus derechos, puedes presentar una reclamación
        ante la Agencia Española de Protección de Datos en
        <a href="https://www.aepd.es" target="_blank" rel="noopener">www.aepd.es</a>. Te agradecemos que antes nos lo
        cuentes para intentar resolverlo.
      </p>
    </section>

    <section id="seguridad">
      <h2>Seguridad y menores</h2>
      <p>
        Aplicamos medidas técnicas y organizativas adecuadas al riesgo: conexión cifrada, control de accesos por
        perfiles, contraseñas protegidas y registros de actividad. Si se produjera una brecha que pusiera en riesgo tus
        derechos, te avisaríamos como exige el RGPD.
      </p>
      <p>La tienda no se dirige a menores de 14 años y no recogemos conscientemente sus datos (art. 7 LOPDGDD).</p>
    </section>

    <section id="cambios">
      <h2>Cambios en esta política</h2>
      <p>
        Si cambiamos la forma de tratar tus datos, actualizaremos esta página y, si el cambio es relevante, te
        avisaremos antes por correo electrónico. Las cookies se explican en la
        <NuxtLink to="/cookies">política de cookies</NuxtLink>.
      </p>
    </section>
  </LegalDocument>
</template>

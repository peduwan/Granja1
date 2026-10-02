# VERI*FACTU — auditoría e implementación

## Estado

Esta rama contiene la primera corrección estructural de la integración VERI*FACTU. **No se declara todavía apta para producción**: quedan pendientes la validación XSD ejecutada en un entorno con libxml2/xmllint, la verificación contra los WSDL/XSD técnicos más recientes descargados directamente de AEAT, la prueba real de integración con certificado y la resolución explícita de la clasificación fiscal de cada operación.

## Arquitectura actual auditada

- Frontend React/TypeScript (Vite) y backend Node/Express.
- Persistencia operativa en Firebase/Firestore y custodia backend de registros fiscales.
- Modelo comercial Factura separado de FiscalRecord, aunque mantiene campos legacy de huella/QR/XML que deben seguir considerándose transitorios/deprecados.
- src/fiscal/ concentra emisión, transformación, hash, QR, XML, transporte, respuestas, certificados y custodia.
- La cadena distribuida usa fiscal_chain_state y transacciones Firestore para evitar bifurcaciones entre instancias.
- Firestore Rules prohíben escrituras fiscales directas desde el navegador.

## Hallazgos críticos

1. La arquitectura ya separa negocio y registro fiscal, pero había valores fiscales y de SIF inventados en createDefaultFiscalConfiguration (B99999999, nombre/version/instalación fija). Se han eliminado los valores de producción y pasan a ser configuración obligatoria del servidor.
2. El XML usa los XSD AEAT locales, pero la validación anterior podía degradar a una validación sintáctica/manual si xmllint no estaba instalado. Se ha cambiado a fail-closed: sin validador XSD real no se permite afirmar conformidad.
3. RefExterna se incorpora al XML para correlación/idempotencia sin introducirlo en la huella.
4. El builder tenía defaults para ClaveRegimen=01, CalificacionOperacion=S1 e Impuesto=01. Se han eliminado: producción debe recibir la clasificación fiscal determinada por el negocio/asesoría y la normativa aplicable.
5. El hash no se calcula sobre el XML completo; el servicio utiliza los campos canónicos definidos por AEAT. Debe conservarse un vector oficial de AEAT como test de regresión.
6. La cadena ya está diseñada para resolver el registro anterior por obligado y confirmar el hash anterior mediante coordinación distribuida; no debe utilizarse el número de factura para localizarlo.
7. El transporte real utiliza HTTPS/mTLS, pero actualmente el proyecto mantiene un mock de pruebas. Producción debe permanecer fail-closed.
8. El QR se genera a partir de NIF, número/serie, fecha e importe y no incorpora la huella. Debe volver a verificarse contra la versión vigente del documento técnico AEAT antes del cierre.
9. La representación de factura contiene texto VERI*FACTU y QR, pero la plantilla todavía lee campos legacy de Factura; debe migrarse a FiscalRecord como fuente única antes de producción.

## Modelo interno → AEAT

| Modelo interno | Registro AEAT |
|---|---|
| Factura.numeroFactura | IDFactura.NumSerieFactura |
| Factura.fecha | IDFactura.FechaExpedicionFactura |
| Factura.clienteNombre | Destinatarios.IDDestinatario.NombreRazon |
| Factura.clienteCif | Destinatarios.IDDestinatario.NIF |
| Factura.totales | Desglose, CuotaTotal, ImporteTotal |
| FiscalRecord.encadenamiento | Encadenamiento |
| FiscalRecord.sistemaInformatico | SistemaInformatico |
| FiscalRecord.fechaHoraHusoGenRegistro | FechaHoraHusoGenRegistro |
| FiscalRecord.huella | TipoHuella + Huella |
| FiscalRecord.referenciaExterna | RefExterna |

Los lotes LoteEnvasado/LotePuesta son trazabilidad de negocio y no se proyectan al registro fiscal salvo que exista un campo AEAT aplicable.

## Huella y encadenamiento

hashService.ts construye la cadena canónica y aplica SHA-256. El hash se almacena en el FiscalRecord y el registro posterior referencia la huella del inmediatamente anterior. La cadena se custodia por obligado tributario y la coordinación Firestore usa OCC/transacción.

## QR

El QR se genera exclusivamente desde el FiscalRecord sellado. No se añade la huella al payload. La URL y parámetros deben permanecer centralizados en aeatEndpoints.ts/qrService.ts y verificarse contra la especificación AEAT vigente antes del despliegue.

## Envío AEAT

El flujo es FiscalRecord inmutable → FiscalSubmission/outbox → SOAP/mTLS → respuesta AEAT. El XML enviado se conserva junto con la respuesta. Los fallos técnicos no deben regenerar el registro ni recalcular su huella.

## Estados

El proyecto implementa PENDING, SENDING, ACCEPTED, ACCEPTED_WITH_ERRORS, REJECTED, FAILED_TECHNICAL y RETRY_PENDING. Los estados de transporte son independientes del registro fiscal inmutable.

## Configuración

Producción debe definir, como mínimo, la identidad estable del SIF mediante secretos/configuración del servidor: SIF_PRODUCER_NAME, SIF_PRODUCER_NIF, SIF_NAME, SIF_ID, SIF_VERSION, SIF_INSTALLATION, SIF_SOLO_VERIFACTU, SIF_MULTI_OT y SIF_MULTIPLES_OT. Debe consolidarse además un único nombre de variable de entorno para el entorno AEAT. Nunca almacenar claves privadas o contraseñas en Git, Firestore, FiscalRecord o logs.

## Validación XML

validateXmlAgainstOfficialXsd() exige xmllint/libxml2 y SuministroLR.xsd. No se debe interpretar una validación sintáctica de XML como validación XSD.

## Tests

El repositorio contiene suites por fases y pruebas adversariales. La ejecución completa debe realizarse en un entorno Node con dependencias instaladas y xmllint/libxml2 disponible. En esta auditoría no se ha podido ejecutar el clon local porque el entorno de ejecución no dispone de resolución de red hacia GitHub; por ello no se afirma que todos los tests pasen.

## Normativa/documentación de referencia auditada

- Real Decreto 1007/2023.
- Orden HAC/1177/2024 y documentación técnica AEAT.
- Real Decreto 254/2025.
- Real Decreto-ley 15/2025, que modificó posteriormente los plazos.
- FAQ VERI*FACTU de AEAT actualizada en 2026.

La fecha de exigibilidad ha sido modificada posteriormente: el RDL 15/2025 fija el 1 de enero de 2027 para los obligados del art. 3.1.a y el 1 de julio de 2027 para el resto de obligados del art. 3.1. Esto no elimina la necesidad de implementar correctamente el sistema; afecta al calendario de exigibilidad.

## Pendientes antes de producción

1. Descargar y versionar las últimas XSD/WSDL oficiales de AEAT con su fecha/versionado.
2. Sustituir cualquier fixture técnico que no proceda directamente de AEAT por un vector oficial verificable.
3. Añadir clasificación fiscal explícita a la factura/operación y eliminar cualquier inferencia de régimen/calificación en producción.
4. Hacer que PDF/impresión lea exclusivamente FiscalRecord.qr y el estado fiscal sellado.
5. Implementar/validar la estrategia oficial de recuperación de timeout/duplicados mediante las operaciones AEAT disponibles, no solo reintento HTTP.
6. Ejecutar todas las suites y una prueba de integración contra preproducción con certificado válido.
7. Revisar la versión técnica AEAT vigente justo antes de producción.
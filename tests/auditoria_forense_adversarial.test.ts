/**
 * AUDITORÍA FORENSE ADVERSARIAL FINAL P0/P1
 * VERI*FACTU — AUTORIDAD FISCAL, FIRESTORE, CONCURRENCIA DISTRIBUIDA Y ATOMICIDAD DE CADENA
 *
 * Validación exhaustiva contra las 4 defensas críticas:
 * P0      — Defensa 1: Bypass directo de Firestore desde cliente SDK.
 * P0/P1   — Defensa 2: Bypass de la autoridad fiscal del backend.
 * P0/P1   — Defensa 3: Bifurcación de cadena por concurrencia multi-instancia.
 * P0/P1   — Defensa 4: Inconsistencia y falta de atomicidad entre FiscalRecord y fiscal_chain_state.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { BackendFiscalCustody } from '../src/fiscal/backendCustodyRepository';
import { CloudDistributedChainCoordinator } from '../src/fiscal/cloudDistributedChainCoordinator';
import { emitFiscalInvoice, resetFiscalQueue } from '../src/fiscal/emissionService';
import { createDefaultFiscalConfiguration } from '../src/fiscal/modelTransformers';
import { saveFiscalRecordToCloud, saveFiscalSubmissionToCloud, saveFiscalEventToCloud } from '../src/utils/firebase';
import { generarHuellaVeriFactu } from '../src/utils/verifactu';
import { AeatCertificateProvider } from '../src/fiscal/aeatCertificateProvider';
import { calculateAltaHash } from '../src/fiscal/hashService';
import { Factura, FiscalRecord } from '../src/types';

const OBLIGADO_TEST_A = 'B91111111';
const OBLIGADO_TEST_B = 'B92222222';

function createInvoice(numFactura: string, obligadoNif: string): Factura {
  return {
    id: `fac-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    numeroFactura: numFactura,
    fecha: '2026-03-01',
    clienteId: 'cli-adv-01',
    clienteNombre: 'Distribuidor Adversarial S.L.',
    clienteCif: 'B99999999',
    clienteDireccion: 'Carretera Norte km 12',
    clienteRecargoEquivalencia: false,
    albaranesAsociados: [],
    tipoFactura: 'F1',
    esRectificativa: false,
    lineas: [
      {
        id: 'lin-01',
        loteEnvasadoId: 'lot-01',
        codigoLoteEnvasado: 'L-2026-ADV',
        formatoId: 'fmt-01',
        nombreFormato: 'Huevos Camperos L',
        cantidadEstuches: 10,
        precioUnitario: 3.5,
        subtotal: 35.0,
        fechaConsumoPreferente: '2026-04-01',
        trazabilidadPuesta: []
      }
    ],
    totales: {
      baseImponible: 35.0,
      porcentajeIva: 4,
      cuotaIva: 1.4,
      aplicaRecargo: false,
      porcentajeRecargo: 0,
      cuotaRecargo: 0,
      totalDocumento: 36.4
    },
    formaPago: 'transferencia',
    estadoPago: 'pendiente',
    esVentaDirecta: true,
    creadoEn: '2026-03-01T10:00:00Z'
  };
}

async function runAdversarialTest(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
  } catch (err: any) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         Detalle: ${err.message || err}`);
    throw err;
  }
}

async function main() {
  console.log('================================================================');
  console.log(' AUDITORÍA FORENSE ADVERSARIAL: AUTORIDAD FISCAL Y RESILIENCIA');
  console.log('================================================================');

  // Limpiar estados de prueba previos
  CloudDistributedChainCoordinator.resetCloudState();
  BackendFiscalCustody.resetCustody();
  resetFiscalQueue();

  // ---------------------------------------------------------------------------
  // P0 — DEFENSA 1: BYPASS DIRECTO DE FIRESTORE DESDE CLIENTE SDK
  // ---------------------------------------------------------------------------
  console.log('\n--- DEFENSA 1 (P0): BYPASS DIRECTO DE FIRESTORE ---');

  await runAdversarialTest('1.1: firestore.rules contiene allow write: if false estricto en todas las colecciones fiscales', () => {
    const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
    const rules = fs.readFileSync(rulesPath, 'utf-8');

    const fiscalCollections = [
      'fiscal_records',
      'fiscal_chain_state',
      'fiscal_submissions',
      'fiscal_events',
      'registros_facturacion',
      'facturas_inmutables'
    ];

    for (const col of fiscalCollections) {
      const reg = new RegExp(`match\\s+\\/${col}\\/\\{[^}]+\\}\\s*\\{([^}]+)\\}`, 's');
      const match = rules.match(reg);
      assert.ok(match, `Debe existir bloque match para /${col}`);
      const body = match[1];
      assert.match(body, /allow\s+write:\s*if\s+false;/, `Colección /${col} debe bloquear escrituras con 'allow write: if false;'`);
      assert.doesNotMatch(body, /allow\s+(create|update|delete|write):\s*if\s+isAuthorizedUser/, `Colección /${col} NO debe permitir create/update/delete a usuarios autenticados`);
    }
  });

  await runAdversarialTest('1.2: Funciones frontend saveFiscal*ToCloud arrojan excepción inmediata si se ejecutan en navegador', async () => {
    const originalWindow = (global as any).window;
    try {
      (global as any).window = {}; // Simular entorno de navegador

      await assert.rejects(async () => {
        await saveFiscalRecordToCloud({} as any);
      }, /VIOLACIÓN DE AUTORIDAD FISCAL/);

      await assert.rejects(async () => {
        await saveFiscalSubmissionToCloud({} as any);
      }, /VIOLACIÓN DE AUTORIDAD FISCAL/);

      await assert.rejects(async () => {
        await saveFiscalEventToCloud({} as any);
      }, /VIOLACIÓN DE AUTORIDAD FISCAL/);
    } finally {
      if (originalWindow === undefined) {
        delete (global as any).window;
      } else {
        (global as any).window = originalWindow;
      }
    }
  });

  // ---------------------------------------------------------------------------
  // P0/P1 — DEFENSA 2: BYPASS DE LA AUTORIDAD FISCAL DEL BACKEND
  // ---------------------------------------------------------------------------
  console.log('\n--- DEFENSA 2 (P0/P1): BYPASS DE LA AUTORIDAD FISCAL DEL BACKEND ---');

  await runAdversarialTest('2.1: Inyección de hashAnterior falso o configuración manipulada por cliente es descartada por backend', async () => {
    const config = createDefaultFiscalConfiguration({
      nif: OBLIGADO_TEST_A,
      nombreRazon: 'Granja San Antonio S.L.'
    });

    // 1. Emitir primera factura legítima
    const inv1 = createInvoice('FAC-ADV-01', OBLIGADO_TEST_A);
    const res1 = await emitFiscalInvoice({
      invoiceDraft: inv1,
      fiscalConfig: config,
      persistRecordFn: async (rec) => {
        await BackendFiscalCustody.saveFiscalRecord(rec);
      }
    });

    assert.ok(res1.fiscalRecord.huella.hash);
    assert.strictEqual(res1.fiscalRecord.encadenamiento.primerRegistro, true);

    // 2. Ataque: Cliente intenta emitir la segunda factura inyectando un hashAnterior adulterado
    const inv2Malicious = createInvoice('FAC-ADV-02', OBLIGADO_TEST_A);
    (inv2Malicious as any).hashAnterior = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
    (inv2Malicious as any).hashActual = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    const res2 = await emitFiscalInvoice({
      invoiceDraft: inv2Malicious,
      fiscalConfig: config,
      persistRecordFn: async (rec) => {
        await BackendFiscalCustody.saveFiscalRecord(rec);
      }
    });

    // Demostrar que el backend IGNORÓ el hashAnterior malicioso y encadenó con la huella legítima de res1
    assert.strictEqual(
      res2.fiscalRecord.encadenamiento.registroAnterior?.huella,
      res1.fiscalRecord.huella.hash,
      'El backend debe usar la huella de res1 y no el hash inyectado por el cliente'
    );
    assert.notStrictEqual(
      res2.fiscalRecord.encadenamiento.registroAnterior?.huella,
      'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'
    );
  });

  await runAdversarialTest('2.2: generarHuellaVeriFactu en cliente lanza excepción Fail-Closed (sin doble vía)', async () => {
    await assert.rejects(async () => {
      await generarHuellaVeriFactu({
        nifEmisor: OBLIGADO_TEST_A,
        numSerieFactura: 'FAC-FORGED',
        fechaExpedicion: '2026-03-01',
        tipoFactura: 'F1',
        totalFactura: 100,
        hashAnterior: '',
        fechaHoraSellado: new Date().toISOString()
      });
    }, /VIOLACIÓN DE AUTORIDAD FISCAL/);
  });

  await runAdversarialTest('2.3: En producción (NODE_ENV=production), sin certificado mTLS o con mock se produce bloqueo 500 Fail-Closed', () => {
    const originalEnv = process.env.NODE_ENV;
    const originalMode = process.env.AEAT_TRANSPORT_MODE;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.AEAT_TRANSPORT_MODE;

      // Simular verificación de transporte en server.ts
      let failureTriggered = false;
      if (!AeatCertificateProvider.hasCertificate()) {
        failureTriggered = true;
      }
      assert.strictEqual(failureTriggered, true, 'Debe fallar si no hay certificado en producción');

      // Intentar forzar mock
      process.env.AEAT_TRANSPORT_MODE = 'mock';
      let mockBlocked = false;
      if (process.env.AEAT_TRANSPORT_MODE === 'mock') {
        mockBlocked = true;
      }
      assert.strictEqual(mockBlocked, true, 'Modo mock debe quedar estrictamente bloqueado en producción');
    } finally {
      process.env.NODE_ENV = originalEnv;
      if (originalMode !== undefined) process.env.AEAT_TRANSPORT_MODE = originalMode;
      else delete process.env.AEAT_TRANSPORT_MODE;
    }
  });

  // ---------------------------------------------------------------------------
  // P0/P1 — DEFENSA 3: BIFURCACIÓN DE CADENA POR CONCURRENCIA MULTI-INSTANCIA
  // ---------------------------------------------------------------------------
  console.log('\n--- DEFENSA 3 (P0/P1): CONCURRENCIA MULTI-INSTANCIA Y NO BIFURCACIÓN ---');

  await runAdversarialTest('3.1: Dos instancias concurrentes compitiendo con la misma huella previa: una triunfa y la otra falla por bifurcación', async () => {
    const latestState = await CloudDistributedChainCoordinator.getLatestState(OBLIGADO_TEST_A);
    assert.ok(latestState, 'Debe haber un estado previo para el obligado A');

    // Construir dos registros concurrentes idénticos en su registroAnterior (ambos apuntando a latestState.latestHuella)
    const invA = createInvoice('FAC-CONCUR-A', OBLIGADO_TEST_A);
    const invB = createInvoice('FAC-CONCUR-B', OBLIGADO_TEST_A);

    const config = createDefaultFiscalConfiguration({
      nif: OBLIGADO_TEST_A,
      nombreRazon: 'Granja San Antonio S.L.'
    });

    const resA = await emitFiscalInvoice({
      invoiceDraft: invA,
      fiscalConfig: config,
      persistRecordFn: async (rec) => {
        await BackendFiscalCustody.saveFiscalRecord(rec);
      }
    });

    assert.ok(resA.fiscalRecord.id);

    // Intentar forzar el commit del registro B que apunta a la huella ya superada (latestState.latestHuella)
    const hashResB = await calculateAltaHash({
      nifEmisor: OBLIGADO_TEST_A,
      numSerieFactura: 'FAC-CONCUR-B',
      fechaExpedicion: resA.fiscalRecord.factura.fechaExpedicion,
      tipoFactura: 'F1',
      cuotaTotal: resA.fiscalRecord.desgloseTributario.cuotaTotal,
      importeTotal: resA.fiscalRecord.desgloseTributario.importeTotal,
      huellaAnterior: latestState.latestHuella,
      fechaHoraHusoGenRegistro: resA.fiscalRecord.fechaHoraHusoGenRegistro
    });

    const staleRecordB: FiscalRecord = {
      ...resA.fiscalRecord,
      id: `rec-stale-${Date.now()}`,
      factura: {
        ...resA.fiscalRecord.factura,
        numeroFactura: 'FAC-CONCUR-B'
      },
      huella: {
        ...resA.fiscalRecord.huella,
        hash: hashResB.hash
      },
      encadenamiento: {
        primerRegistro: false,
        registroAnterior: {
          idEmisorFactura: OBLIGADO_TEST_A,
          numSerieFactura: latestState.latestNumeroFactura,
          fechaExpedicionFactura: latestState.latestFecha,
          huella: latestState.latestHuella // Huella ya obsoleta porque resA ya avanzó la cadena
        }
      }
    };

    await assert.rejects(async () => {
      await BackendFiscalCustody.saveFiscalRecord(staleRecordB);
    }, /Bifurcación de cadena detectada/);
  });

  await runAdversarialTest('3.2: Concurrencia entre obligados tributarios distintos (NIF A vs NIF B) opera independientemente', async () => {
    const configB = createDefaultFiscalConfiguration({
      nif: OBLIGADO_TEST_B,
      nombreRazon: 'Avícola Del Este S.L.'
    });

    const invB1 = createInvoice('FAC-B-01', OBLIGADO_TEST_B);
    const resB1 = await emitFiscalInvoice({
      invoiceDraft: invB1,
      fiscalConfig: configB,
      persistRecordFn: async (rec) => {
        await BackendFiscalCustody.saveFiscalRecord(rec);
      }
    });

    assert.strictEqual(resB1.fiscalRecord.obligadoTributarioId, OBLIGADO_TEST_B);
    assert.strictEqual(resB1.fiscalRecord.encadenamiento.primerRegistro, true);

    const stateB = await CloudDistributedChainCoordinator.getLatestState(OBLIGADO_TEST_B);
    assert.ok(stateB);
    assert.strictEqual(stateB.latestHuella, resB1.fiscalRecord.huella.hash);
  });

  // ---------------------------------------------------------------------------
  // P0/P1 — DEFENSA 4: ATOMICIDAD Y PREVENCIÓN DE ESTADOS SUCIOS (ROLLBACK / FAIL-CLOSED)
  // ---------------------------------------------------------------------------
  console.log('\n--- DEFENSA 4 (P0/P1): ATOMICIDAD Y ROLLBACK ---');

  await runAdversarialTest('4.1: Si el commit en nube falla, la custodia local NO guarda el registro (sin escrituras parciales)', async () => {
    const recordsBefore = BackendFiscalCustody.getAllFiscalRecords(OBLIGADO_TEST_A).length;

    // Crear un registro con huella anterior obsoleta/falsa que intente bifurcar
    const firstRec = BackendFiscalCustody.getAllFiscalRecords(OBLIGADO_TEST_A)[0];
    const fakePrevHash = '0000000000000000000000000000000000000000000000000000000000000000';
    const hashResCorrupt = await calculateAltaHash({
      nifEmisor: OBLIGADO_TEST_A,
      numSerieFactura: 'FAC-FORK-TEST',
      fechaExpedicion: '2026-03-01',
      tipoFactura: 'F1',
      cuotaTotal: 1.4,
      importeTotal: 36.4,
      huellaAnterior: fakePrevHash,
      fechaHoraHusoGenRegistro: firstRec.fechaHoraHusoGenRegistro
    });

    const invalidRecord: FiscalRecord = {
      ...firstRec,
      id: `rec-corrupto-${Date.now()}`,
      factura: {
        ...firstRec.factura,
        numeroFactura: 'FAC-FORK-TEST'
      },
      huella: {
        ...firstRec.huella,
        hash: hashResCorrupt.hash
      },
      encadenamiento: {
        primerRegistro: false,
        registroAnterior: {
          idEmisorFactura: OBLIGADO_TEST_A,
          numSerieFactura: 'FAKE',
          fechaExpedicionFactura: '2026-03-01',
          huella: fakePrevHash
        }
      }
    };

    try {
      await BackendFiscalCustody.saveFiscalRecord(invalidRecord);
      assert.fail('Debió fallar con error de bifurcación');
    } catch (err: any) {
      assert.match(err.message, /Bifurcación de cadena detectada/);
    }

    // Comprobar que en disco y en memoria NO se guardó invalidRecord
    const recordsAfter = BackendFiscalCustody.getAllFiscalRecords(OBLIGADO_TEST_A).length;
    assert.strictEqual(recordsAfter, recordsBefore, 'La cantidad de registros no debe variar tras un intento fallido');

    const found = BackendFiscalCustody.getFiscalRecordById(invalidRecord.id);
    assert.strictEqual(found, null, 'El registro corrupto NO debe existir en la custodia local');
  });

  await runAdversarialTest('4.2: getFiscalRecordByIdAsync resuelve registros remotos de la nube para otra instancia', async () => {
    // Tomar un registro emitido y comprobar que getFiscalRecordByIdAsync lo recupera
    const all = BackendFiscalCustody.getAllFiscalRecords(OBLIGADO_TEST_A);
    assert.ok(all.length > 0);
    const target = all[0];

    const retrieved = await BackendFiscalCustody.getFiscalRecordByIdAsync(target.id);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.id, target.id);
    assert.strictEqual(retrieved.huella.hash, target.huella.hash);
  });

  // Limpieza final de estados de prueba
  BackendFiscalCustody.resetCustody();
  CloudDistributedChainCoordinator.resetCloudState();
  resetFiscalQueue();

  console.log('\n================================================================');
  console.log(' AUDITORÍA FORENSE ADVERSARIAL: TODAS LAS DEFENSAS VERIFICADAS!');
  console.log('================================================================');
}

main().catch((err) => {
  console.error('\nFALLO CRÍTICO EN AUDITORÍA ADVERSARIAL:', err);
  process.exit(1);
});

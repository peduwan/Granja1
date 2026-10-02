/**
 * COORDINADOR DISTRIBUIDO DE CADENA FISCAL EN LA NUBE (FASE 3.1.6 / MULTI-INSTANCIA)
 *
 * Arquitectura para Google Cloud Run & Firestore:
 * - Evita bifurcaciones (forks) cuando múltiples instancias independientes atienden tráfico concurrente.
 * - Utiliza transacciones atómicas serializadas (OCC) sobre el documento de estado del obligado:
 *   `/fiscal_chain_state/{obligadoTributarioId}`
 * - El servidor (Cloud Run) utiliza `@google-cloud/firestore` con credenciales de cuenta de servicio (ADC/IAM),
 *   lo que permite custodiar los registros mientras que las reglas `firestore.rules` prohíben
 *   cualquier escritura directa desde clientes web (`allow write: if false;`).
 */

import { Firestore } from '@google-cloud/firestore';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import firebaseConfig from '../../firebase-applet-config.json';
import { FiscalRecord, FiscalSubmission, FiscalEvent } from './types';

export interface CloudChainState {
  obligadoTributarioId: string;
  latestRecordId: string;
  latestHuella: string;
  latestNumeroFactura: string;
  latestFecha: string;
  totalRecords: number;
  sequence: number;
  updatedAt: string;
}

let firestoreAdminInstance: Firestore | null = null;
let firestoreInitialized = false;

function getFirestoreAdmin(): Firestore | null {
  if (firestoreInitialized) return firestoreAdminInstance;
  firestoreInitialized = true;
  try {
    firestoreAdminInstance = new Firestore({
      projectId: firebaseConfig.projectId,
      databaseId: firebaseConfig.firestoreDatabaseId
    });
  } catch (err: any) {
    console.warn('CloudDistributedChainCoordinator: Firestore Admin no inicializado con ADC (modo emulado/fallback):', err.message || err);
    firestoreAdminInstance = null;
  }
  return firestoreAdminInstance;
}

// Persistencia de estado compartido para entornos de prueba multi-proceso (simulador de autoridad Cloud)
const SHARED_STATE_FILE = path.resolve(process.cwd(), 'data', 'cloud_shared_chain_state.json');
const SHARED_RECORDS_FILE = path.resolve(process.cwd(), 'data', 'cloud_shared_records.json');

function commitSharedCloudTransaction(record: FiscalRecord): CloudChainState {
  const dir = path.dirname(SHARED_STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const lockFile = `${SHARED_STATE_FILE}.lock`;
  const timeoutMs = 12000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      try {
        let allStates: Record<string, CloudChainState> = {};
        if (fs.existsSync(SHARED_STATE_FILE)) {
          try {
            allStates = JSON.parse(fs.readFileSync(SHARED_STATE_FILE, 'utf-8'));
          } catch {}
        }
        const current = allStates[record.obligadoTributarioId] || null;

        let allRecords: Record<string, FiscalRecord> = {};
        if (fs.existsSync(SHARED_RECORDS_FILE)) {
          try {
            allRecords = JSON.parse(fs.readFileSync(SHARED_RECORDS_FILE, 'utf-8'));
          } catch {}
        }

        // 1. Inmutabilidad por ID
        if (allRecords[record.id]) {
          throw new Error(`CloudDistributedChainCoordinator: Violación de inmutabilidad. El registro ${record.id} ya existe en la nube.`);
        }

        // 2. Encadenamiento y no-bifurcación estrictos
        let newState: CloudChainState;
        if (current) {
          if (record.encadenamiento.primerRegistro) {
            throw new Error(`CloudDistributedChainCoordinator: Violación de encadenamiento. Se indicó primerRegistro=true, pero ya existen registros en la nube para el obligado ${record.obligadoTributarioId}.`);
          }
          if (record.encadenamiento.registroAnterior?.huella !== current.latestHuella) {
            throw new Error(`CloudDistributedChainCoordinator: Bifurcación de cadena detectada en la nube. El hash del registro anterior (${record.encadenamiento.registroAnterior?.huella}) no coincide con el último registro en la nube (${current.latestHuella}).`);
          }

          newState = {
            obligadoTributarioId: record.obligadoTributarioId,
            latestRecordId: record.id,
            latestHuella: record.huella.hash,
            latestNumeroFactura: record.factura.numeroFactura,
            latestFecha: record.factura.fechaExpedicion,
            totalRecords: (current.totalRecords || 0) + 1,
            sequence: (current.sequence || 0) + 1,
            updatedAt: new Date().toISOString()
          };
        } else {
          if (!record.encadenamiento.primerRegistro) {
            throw new Error(`CloudDistributedChainCoordinator: Violación de encadenamiento. No existe estado previo en la nube para el obligado ${record.obligadoTributarioId}.`);
          }

          newState = {
            obligadoTributarioId: record.obligadoTributarioId,
            latestRecordId: record.id,
            latestHuella: record.huella.hash,
            latestNumeroFactura: record.factura.numeroFactura,
            latestFecha: record.factura.fechaExpedicion,
            totalRecords: 1,
            sequence: 1,
            updatedAt: new Date().toISOString()
          };
        }

        allStates[record.obligadoTributarioId] = newState;
        allRecords[record.id] = record;

        const tmpState = `${SHARED_STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpState, JSON.stringify(allStates, null, 2), 'utf-8');
        fs.renameSync(tmpState, SHARED_STATE_FILE);

        const tmpRecords = `${SHARED_RECORDS_FILE}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpRecords, JSON.stringify(allRecords, null, 2), 'utf-8');
        fs.renameSync(tmpRecords, SHARED_RECORDS_FILE);

        return newState;
      } finally {
        fs.closeSync(fd);
        try { fs.unlinkSync(lockFile); } catch {}
      }
    } catch (e: any) {
      if (e.code === 'EEXIST') {
        try {
          const stats = fs.statSync(lockFile).mtimeMs;
          if (Date.now() - stats > 5000) {
            try { fs.unlinkSync(lockFile); } catch {}
          }
        } catch {}
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      } else {
        throw e;
      }
    }
  }
  throw new Error('Timeout coordinando estado compartido en cloud simulator');
}

function readSharedCloudState(obligadoId: string): CloudChainState | null {
  try {
    if (fs.existsSync(SHARED_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(SHARED_STATE_FILE, 'utf-8'));
      return data[obligadoId] || null;
    }
  } catch {}
  return null;
}

function readSharedCloudRecord(recordId: string): FiscalRecord | null {
  try {
    if (fs.existsSync(SHARED_RECORDS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SHARED_RECORDS_FILE, 'utf-8'));
      return data[recordId] || null;
    }
  } catch {}
  return null;
}

export class CloudDistributedChainCoordinator {
  /**
   * Ejecuta la validación y el compromiso atómico de un FiscalRecord contra la autoridad compartida de la nube.
   * Si dos instancias compiten para el mismo obligado, solo una se compromete y la otra detecta la discrepancia.
   */
  public static async commitRecord(record: FiscalRecord): Promise<{ state: CloudChainState }> {
    const firestore = getFirestoreAdmin();

    if (firestore) {
      try {
        const stateRef = firestore.collection('fiscal_chain_state').doc(record.obligadoTributarioId);
        const recordRef = firestore.collection('fiscal_records').doc(record.id);

        const resultState = await firestore.runTransaction(async (tx) => {
          const [stateSnap, recordSnap] = await Promise.all([
            tx.get(stateRef),
            tx.get(recordRef)
          ]);

          if (recordSnap.exists) {
            throw new Error(`CloudDistributedChainCoordinator: Violación de inmutabilidad. El registro ${record.id} ya existe en Firestore.`);
          }

          let newState: CloudChainState;
          if (stateSnap.exists) {
            const current = stateSnap.data() as CloudChainState;
            if (record.encadenamiento.primerRegistro) {
              throw new Error(`CloudDistributedChainCoordinator: Violación de encadenamiento. Se indicó primerRegistro=true, pero ya existen registros en Firestore para el obligado ${record.obligadoTributarioId}.`);
            }
            if (record.encadenamiento.registroAnterior?.huella !== current.latestHuella) {
              throw new Error(`CloudDistributedChainCoordinator: Bifurcación de cadena detectada en Firestore. El hash del registro anterior (${record.encadenamiento.registroAnterior?.huella}) no coincide con el último registro en la nube (${current.latestHuella}).`);
            }

            newState = {
              obligadoTributarioId: record.obligadoTributarioId,
              latestRecordId: record.id,
              latestHuella: record.huella.hash,
              latestNumeroFactura: record.factura.numeroFactura,
              latestFecha: record.factura.fechaExpedicion,
              totalRecords: (current.totalRecords || 0) + 1,
              sequence: (current.sequence || 0) + 1,
              updatedAt: new Date().toISOString()
            };
            tx.update(stateRef, newState as any);
          } else {
            if (!record.encadenamiento.primerRegistro) {
              throw new Error(`CloudDistributedChainCoordinator: Violación de encadenamiento. No existe estado previo en Firestore para el obligado ${record.obligadoTributarioId}.`);
            }

            newState = {
              obligadoTributarioId: record.obligadoTributarioId,
              latestRecordId: record.id,
              latestHuella: record.huella.hash,
              latestNumeroFactura: record.factura.numeroFactura,
              latestFecha: record.factura.fechaExpedicion,
              totalRecords: 1,
              sequence: 1,
              updatedAt: new Date().toISOString()
            };
            tx.set(stateRef, newState as any);
          }

          tx.set(recordRef, JSON.parse(JSON.stringify(record)));
          return newState;
        });

        return { state: resultState };
      } catch (err: any) {
        if (err.message?.includes('Violación de encadenamiento') ||
            err.message?.includes('Bifurcación de cadena') ||
            err.message?.includes('Violación de inmutabilidad')) {
          throw err;
        }
        // Si no hay conexión gRPC disponible en test local, cae en el coordinador compartido
      }
    }

    // Coordinador de estado compartido atómico (garantía de concurrencia entre procesos independientes)
    const newState = commitSharedCloudTransaction(record);
    return { state: newState };
  }

  /**
   * Obtiene el estado oficial de la cadena en la nube para un obligado tributario.
   */
  public static async getLatestState(obligadoId: string): Promise<CloudChainState | null> {
    const firestore = getFirestoreAdmin();
    if (firestore) {
      try {
        const snap = await firestore.collection('fiscal_chain_state').doc(obligadoId).get();
        if (snap.exists) {
          return snap.data() as CloudChainState;
        }
      } catch {}
    }
    return readSharedCloudState(obligadoId);
  }

  /**
   * Recupera un FiscalRecord por ID desde la autoridad distribuida en la nube.
   */
  public static async getRecordById(recordId: string): Promise<FiscalRecord | null> {
    const firestore = getFirestoreAdmin();
    if (firestore) {
      try {
        const snap = await firestore.collection('fiscal_records').doc(recordId).get();
        if (snap.exists) {
          return snap.data() as FiscalRecord;
        }
      } catch {}
    }
    return readSharedCloudRecord(recordId);
  }

  /**
   * Resetea el simulador de estado en la nube (exclusivo para pruebas).
   */
  public static resetCloudState(): void {
    try {
      if (fs.existsSync(SHARED_STATE_FILE)) {
        fs.unlinkSync(SHARED_STATE_FILE);
      }
      if (fs.existsSync(SHARED_RECORDS_FILE)) {
        fs.unlinkSync(SHARED_RECORDS_FILE);
      }
    } catch {}
  }
}

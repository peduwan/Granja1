/**
 * REPOSITORIO DE CUSTODIA FISCAL DE BACKEND (FASE 3.1.3)
 *
 * Normativa:
 * - Ley 11/2021 de medidas contra el fraude fiscal
 * - Real Decreto 1007/2023 (Reglamento Veri*Factu / SIF)
 * - Orden HAC/1177/2024
 *
 * AUTORIDAD EXCLUSIVA DE BACKEND:
 * 1. La custodia física y lógica de los registros fiscales reside en el backend.
 * 2. El cliente/navegador nunca inserta ni altera registros fiscales directamente.
 * 3. Garantiza la integridad de la cadena impidiendo bifurcaciones por concurrencia.
 * 4. Valida criptográficamente cada registro antes de persistirlo.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FiscalRecord, FiscalSubmission, FiscalEvent } from './types';
import { verifyFiscalRecordHash } from './hashService';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const LOCKS_DIR = path.join(DATA_DIR, 'locks');
const RECORDS_FILE = path.join(DATA_DIR, 'fiscal_records.json');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'fiscal_submissions.json');
const EVENTS_FILE = path.join(DATA_DIR, 'fiscal_events.json');

// Memoria caché del backend sincronizada con persistencia en disco
let recordsCache: FiscalRecord[] = [];
let submissionsCache: FiscalSubmission[] = [];
let eventsCache: FiscalEvent[] = [];
let initialized = false;

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(LOCKS_DIR)) {
    fs.mkdirSync(LOCKS_DIR, { recursive: true });
  }
}

function loadFromDisk(): void {
  ensureDataDir();
  try {
    if (fs.existsSync(RECORDS_FILE)) {
      const raw = fs.readFileSync(RECORDS_FILE, 'utf-8');
      recordsCache = JSON.parse(raw);
    } else {
      recordsCache = [];
    }
  } catch (err) {
    console.error('Error cargando fiscal_records.json:', err);
    recordsCache = [];
  }

  try {
    if (fs.existsSync(SUBMISSIONS_FILE)) {
      const raw = fs.readFileSync(SUBMISSIONS_FILE, 'utf-8');
      submissionsCache = JSON.parse(raw);
    } else {
      submissionsCache = [];
    }
  } catch (err) {
    console.error('Error cargando fiscal_submissions.json:', err);
    submissionsCache = [];
  }

  try {
    if (fs.existsSync(EVENTS_FILE)) {
      const raw = fs.readFileSync(EVENTS_FILE, 'utf-8');
      eventsCache = JSON.parse(raw);
    } else {
      eventsCache = [];
    }
  } catch (err) {
    console.error('Error cargando fiscal_events.json:', err);
    eventsCache = [];
  }

  initialized = true;
}

function persistRecordsToDisk(): void {
  ensureDataDir();
  const tmpFile = `${RECORDS_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(recordsCache, null, 2), 'utf-8');
  fs.renameSync(tmpFile, RECORDS_FILE);
}

function persistSubmissionsToDisk(): void {
  ensureDataDir();
  const tmpFile = `${SUBMISSIONS_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(submissionsCache, null, 2), 'utf-8');
  fs.renameSync(tmpFile, SUBMISSIONS_FILE);
}

function persistEventsToDisk(): void {
  ensureDataDir();
  const tmpFile = `${EVENTS_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(eventsCache, null, 2), 'utf-8');
  fs.renameSync(tmpFile, EVENTS_FILE);
}

// Registro en memoria de cerrojos activos en este proceso para re-entrancia segura
const activeLocksByObligado = new Map<string, string>();

/**
 * Comprueba si un proceso sigue en ejecución en el sistema operativo.
 */
function isProcessAlive(pid: number): boolean {
  if (isNaN(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM'; // Si EPERM, el proceso existe pero pertenece a otro usuario
  }
}

export class BackendFiscalCustody {
  private static init(): void {
    if (!initialized) {
      loadFromDisk();
    }
  }

  /**
   * Cerrojo exclusivo a nivel de proceso/sistema de ficheros para serializar emisiones concurrentes.
   * - FAIL CLOSED: Si no se adquiere en timeoutMs, lanza un error fatal.
   * - OWNERSHIP: Cada adquisición genera un token criptográfico único; solo el titular puede liberarlo.
   * - LIVENESS: Solo descarta cerrojos si el PID titular ha muerto.
   */
  public static async acquireProcessLock(obligadoTributarioId: string, timeoutMs = 8000): Promise<() => void> {
    ensureDataDir();
    const cleanId = obligadoTributarioId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const lockPath = path.join(LOCKS_DIR, `obligado_${cleanId}.lock`);
    const startTime = Date.now();
    const ownerToken = `${process.pid}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, ownerToken);
        fs.closeSync(fd);

        activeLocksByObligado.set(obligadoTributarioId, ownerToken);

        // Retornar función de liberación condicional exclusiva del titular
        let released = false;
        return () => {
          if (released) return;
          released = true;
          activeLocksByObligado.delete(obligadoTributarioId);
          try {
            if (fs.existsSync(lockPath)) {
              const currentContent = fs.readFileSync(lockPath, 'utf-8').trim();
              if (currentContent === ownerToken) {
                fs.unlinkSync(lockPath);
              }
            }
          } catch {}
        };
      } catch (err: any) {
        if (err.code === 'EEXIST') {
          // El lock ya existe: verificar si el proceso dueño sigue vivo
          try {
            if (fs.existsSync(lockPath)) {
              const rawContent = fs.readFileSync(lockPath, 'utf-8').trim();
              const [ownerPidStr, timestampStr] = rawContent.split(':');
              const ownerPid = parseInt(ownerPidStr, 10);
              const lockTimestamp = parseInt(timestampStr, 10);

              const ownerAlive = isProcessAlive(ownerPid);
              const isDeadOwner = !ownerAlive && (Date.now() - lockTimestamp > 2000);
              const isExtremeStale = (Date.now() - lockTimestamp > 120000);

              if (isDeadOwner || isExtremeStale) {
                try {
                  fs.unlinkSync(lockPath);
                  continue;
                } catch {}
              }
            }
          } catch {}

          await new Promise(resolve => setTimeout(resolve, 40));
        } else {
          throw err;
        }
      }
    }

    // FAIL CLOSED: Si expira el tiempo sin adquirir el cerrojo, rechazar la operación rotundamente
    throw new Error(
      `BackendFiscalCustody: Timeout (${timeoutMs}ms) al adquirir cerrojo de emisión exclusivo para el obligado '${obligadoTributarioId}'. Operación fiscal abortada para evitar condiciones de carrera o bifurcación.`
    );
  }

  /**
   * Guarda un FiscalRecord en la custodia inmutable de backend tras verificar su integridad
   * y garantizar la no-bifurcación de la cadena criptográfica SHA-256.
   * Adquiere automáticamente el cerrojo si la llamada no lo sostiene previamente.
   */
  public static async saveFiscalRecord(record: FiscalRecord): Promise<void> {
    if (!record || !record.id) {
      throw new Error('BackendFiscalCustody: Se requiere un FiscalRecord válido con identificador.');
    }

    if (!record.obligadoTributarioId || record.obligadoTributarioId === 'ES_UNKNOWN' || record.obligadoTributarioId.trim() === '') {
      throw new Error('BackendFiscalCustody: obligadoTributarioId inválido o no especificado.');
    }

    // Si este hilo no posee el lock del obligado, adquirirlo transaccionalmente
    const alreadyLocked = activeLocksByObligado.has(record.obligadoTributarioId);
    let releaseLock: (() => void) | null = null;
    if (!alreadyLocked) {
      releaseLock = await this.acquireProcessLock(record.obligadoTributarioId);
    }

    try {
      this.init();
      loadFromDisk();

      // 1. Verificación de integridad matemática previa a la custodia
      const verification = await verifyFiscalRecordHash(record);
      if (!verification.valid) {
        throw new Error(`BackendFiscalCustody: Fallo de integridad criptográfica en el registro (${verification.reason}). Custodia rechazada.`);
      }

      // 2. Comprobar que no exista duplicado por ID
      const exists = recordsCache.some(r => r.id === record.id);
      if (exists) {
        throw new Error(`BackendFiscalCustody: Violación de inmutabilidad. El registro ${record.id} ya existe en la custodia fiscal.`);
      }

      // 3. Garantía absoluta de no bifurcación de la cadena por concurrencia
      const latestInChain = this.getLatestFiscalRecord(record.obligadoTributarioId);
      if (record.encadenamiento.primerRegistro) {
        if (latestInChain) {
          throw new Error(`BackendFiscalCustody: Violación de encadenamiento. Se indicó primerRegistro=true, pero ya existen ${recordsCache.filter(r => r.obligadoTributarioId === record.obligadoTributarioId).length} registros en custodia para el obligado ${record.obligadoTributarioId}.`);
        }
      } else {
        if (!latestInChain) {
          throw new Error(`BackendFiscalCustody: Violación de encadenamiento. No existe registro previo en custodia para el obligado ${record.obligadoTributarioId}.`);
        }
        if (record.encadenamiento.registroAnterior?.huella !== latestInChain.huella.hash) {
          throw new Error(`BackendFiscalCustody: Bifurcación de cadena detectada. El hash del registro anterior no coincide con el último registro existente en la custodia fiscal.`);
        }
      }

      // 4. Persistir en custodia inmutable
      recordsCache.push(Object.freeze(record));
      try {
        persistRecordsToDisk();
      } catch (err) {
        console.error('BackendFiscalCustody: Error persistiendo a disco:', err);
        throw err;
      }
    } finally {
      if (releaseLock) {
        releaseLock();
      }
    }
  }

  /**
   * Obtiene el último registro fiscal sellado para un obligado tributario.
   * Resuelve matemáticamente la cabeza/punta de la cadena criptográfica SHA-256.
   */
  public static getLatestFiscalRecord(obligadoTributarioId: string): FiscalRecord | null {
    this.init();
    loadFromDisk();
    if (!obligadoTributarioId) return null;

    const matching = recordsCache.filter(r => r.obligadoTributarioId === obligadoTributarioId);
    if (matching.length === 0) return null;
    if (matching.length === 1) return matching[0];

    // Encontrar el registro cuya huella no es predecesora de ningún otro registro en la cadena
    const referencedPredecessors = new Set<string>();
    for (const r of matching) {
      if (r.encadenamiento.registroAnterior?.huella) {
        referencedPredecessors.add(r.encadenamiento.registroAnterior.huella);
      }
    }

    const tips = matching.filter(r => !referencedPredecessors.has(r.huella.hash));
    if (tips.length > 0) {
      return tips[tips.length - 1];
    }

    return matching[matching.length - 1];
  }

  /**
   * Recupera un registro fiscal por ID desde la custodia del backend.
   */
  public static getFiscalRecordById(recordId: string): FiscalRecord | null {
    this.init();
    return recordsCache.find(r => r.id === recordId) || null;
  }

  /**
   * Obtiene todos los registros fiscales de la custodia.
   */
  public static getAllFiscalRecords(obligadoTributarioId?: string): FiscalRecord[] {
    this.init();
    if (obligadoTributarioId) {
      return recordsCache.filter(r => r.obligadoTributarioId === obligadoTributarioId);
    }
    return [...recordsCache];
  }

  /**
   * Registra una FiscalSubmission en la custodia de envíos.
   */
  public static saveFiscalSubmission(submission: FiscalSubmission): void {
    this.init();
    const idx = submissionsCache.findIndex(s => s.id === submission.id);
    if (idx !== -1) {
      submissionsCache[idx] = Object.freeze(submission);
    } else {
      submissionsCache.push(Object.freeze(submission));
    }
    try {
      persistSubmissionsToDisk();
    } catch (err) {
      console.error('BackendFiscalCustody: Error persistiendo submission:', err);
    }
  }

  /**
   * Obtiene las sumisiones registradas en el backend.
   */
  public static getFiscalSubmissions(fiscalRecordId?: string): FiscalSubmission[] {
    this.init();
    if (fiscalRecordId) {
      return submissionsCache.filter(s => s.fiscalRecordId === fiscalRecordId);
    }
    return [...submissionsCache];
  }

  /**
   * Registra un FiscalEvent de auditoría en la custodia del backend.
   */
  public static saveFiscalEvent(event: FiscalEvent): void {
    this.init();
    eventsCache.push(Object.freeze(event));
    try {
      persistEventsToDisk();
    } catch (err) {
      console.error('BackendFiscalCustody: Error persistiendo event:', err);
    }
  }

  /**
   * Obtiene los eventos de auditoría.
   */
  public static getFiscalEvents(fiscalRecordId?: string): FiscalEvent[] {
    this.init();
    if (fiscalRecordId) {
      return eventsCache.filter(e => e.fiscalRecordId === fiscalRecordId);
    }
    return [...eventsCache];
  }

  /**
   * Reinicia la custodia en memoria y en disco (exclusivo para testing).
   */
  public static resetCustody(): void {
    recordsCache = [];
    submissionsCache = [];
    eventsCache = [];
    initialized = true;
    try {
      if (fs.existsSync(RECORDS_FILE)) fs.unlinkSync(RECORDS_FILE);
      if (fs.existsSync(SUBMISSIONS_FILE)) fs.unlinkSync(SUBMISSIONS_FILE);
      if (fs.existsSync(EVENTS_FILE)) fs.unlinkSync(EVENTS_FILE);
    } catch {}
  }
}

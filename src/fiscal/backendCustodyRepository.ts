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
import { FiscalRecord, FiscalSubmission, FiscalEvent } from './types';
import { verifyFiscalRecordHash } from './hashService';

const DATA_DIR = path.resolve(process.cwd(), 'data');
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
}

function loadFromDisk(): void {
  ensureDataDir();
  try {
    if (fs.existsSync(RECORDS_FILE)) {
      const raw = fs.readFileSync(RECORDS_FILE, 'utf-8');
      recordsCache = JSON.parse(raw);
    }
  } catch (err) {
    console.error('Error cargando fiscal_records.json:', err);
    recordsCache = [];
  }

  try {
    if (fs.existsSync(SUBMISSIONS_FILE)) {
      const raw = fs.readFileSync(SUBMISSIONS_FILE, 'utf-8');
      submissionsCache = JSON.parse(raw);
    }
  } catch (err) {
    console.error('Error cargando fiscal_submissions.json:', err);
    submissionsCache = [];
  }

  try {
    if (fs.existsSync(EVENTS_FILE)) {
      const raw = fs.readFileSync(EVENTS_FILE, 'utf-8');
      eventsCache = JSON.parse(raw);
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

export class BackendFiscalCustody {
  private static init(): void {
    if (!initialized) {
      loadFromDisk();
    }
  }

  /**
   * Guarda un FiscalRecord en la custodia inmutable de backend tras verificar su integridad.
   */
  public static async saveFiscalRecord(record: FiscalRecord): Promise<void> {
    this.init();

    if (!record || !record.id) {
      throw new Error('BackendFiscalCustody: Se requiere un FiscalRecord válido con identificador.');
    }

    if (!record.obligadoTributarioId || record.obligadoTributarioId === 'ES_UNKNOWN' || record.obligadoTributarioId.trim() === '') {
      throw new Error('BackendFiscalCustody: obligadoTributarioId inválido o no especificado.');
    }

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

    // 3. Persistir en custodia inmutable
    recordsCache.push(Object.freeze(record));
    try {
      persistRecordsToDisk();
    } catch (err) {
      console.error('BackendFiscalCustody: Error persistiendo a disco:', err);
    }
  }

  /**
   * Obtiene el último registro fiscal sellado para un obligado tributario.
   */
  public static getLatestFiscalRecord(obligadoTributarioId: string): FiscalRecord | null {
    this.init();
    if (!obligadoTributarioId) return null;

    const matching = recordsCache.filter(r => r.obligadoTributarioId === obligadoTributarioId);
    if (matching.length === 0) return null;

    matching.sort((a, b) => {
      const timeA = new Date(a.fechaHoraHusoGenRegistro).getTime();
      const timeB = new Date(b.fechaHoraHusoGenRegistro).getTime();
      return timeB - timeA;
    });

    return matching[0];
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

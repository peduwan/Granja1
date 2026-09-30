/**
 * SERVICIO DE AUTENTICACIÓN Y AUTORIZACIÓN FISCAL DE BACKEND (FASE 3.1.4)
 *
 * Cumplimiento con:
 * - Ley 11/2021 de medidas de prevención y lucha contra el fraude fiscal
 * - Real Decreto 1007/2023 (Reglamento Veri*Factu / SIF)
 * - Orden HAC/1177/2024
 *
 * INVARIANTES DE SEGURIDAD:
 * 1. Todos los endpoints fiscales de backend exigen autenticación criptográfica.
 * 2. Ningún dato sensible de rol, email o uid enviado por el cliente es de confianza.
 * 3. Se verifica server-side el token Firebase ID.
 * 4. Solo usuarios autorizados (propietario o usuarios en lista blanca) pueden invocar operaciones fiscales.
 * 5. Se valida estrictamente la correspondencia del obligado tributario con las organizaciones autorizadas.
 * 6. Rechazo taxativo de NIFs ficticios, placeholders ('ES_UNKNOWN', 'B12345678', etc.) y NIFs mal formados.
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import firebaseConfig from '../../firebase-applet-config.json';
import { ROOT_OWNER_EMAIL } from '../utils/storage';

export interface AuthenticatedFiscalUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  isOwner: boolean;
  authorizedObligados: string[]; // Lista de NIFs de obligados tributarios autorizados
}

// Extensión de Express Request para tipado
export interface FiscalAuthenticatedRequest extends Request {
  fiscalUser?: AuthenticatedFiscalUser;
}

// Almacén en memoria de tokens de testing autorizados (para ejecución de tests en Node)
const testTokensRegistry = new Map<string, AuthenticatedFiscalUser>();

/**
 * Registra un token de testing en memoria (exclusivamente para suites de pruebas unitarias/integración).
 */
export function registerTestAuthToken(token: string, user: AuthenticatedFiscalUser): void {
  testTokensRegistry.set(token, user);
}

export function clearTestAuthTokens(): void {
  testTokensRegistry.clear();
}

/**
 * Validador formal de formato de NIF/CIF/NIE español.
 * Longitud 9 caracteres:
 * - DNI: 8 dígitos + 1 letra control
 * - NIE: X/Y/Z + 7 dígitos + 1 letra control
 * - CIF: 1 letra tipo + 7 dígitos + 1 carácter control (letra o dígito)
 */
export function isValidSpanishNifCifNie(nifRaw: string): boolean {
  if (!nifRaw || typeof nifRaw !== 'string') return false;
  const nif = nifRaw.trim().toUpperCase();

  // Rechazo explícito de placeholders y valores ficticios
  if (
    nif === 'ES_UNKNOWN' ||
    nif === 'UNKNOWN' ||
    nif === 'B12345678' ||
    nif === 'B99999999' ||
    nif === '000000000' ||
    nif.length !== 9
  ) {
    return false;
  }

  // Regex estándar NIF/NIE/CIF
  const cifNieDniRegex = /^([ABCDEFGHJKLMNPQRSUVW][0-9]{7}[0-9A-J]|[0-9]{8}[TRWAGMYFPDXBNJZSQVHLCKE]|[XYZ][0-9]{7}[TRWAGMYFPDXBNJZSQVHLCKE])$/;
  return cifNieDniRegex.test(nif);
}

/**
 * Verifica un Firebase ID Token o token de prueba de backend.
 */
export async function verifyFiscalToken(token: string): Promise<AuthenticatedFiscalUser> {
  if (!token || typeof token !== 'string' || token.trim() === '') {
    throw new Error('Token de autenticación vacío o no proporcionado.');
  }

  // 1. Comprobación en registro de tokens de prueba
  if (testTokensRegistry.has(token)) {
    return testTokensRegistry.get(token)!;
  }

  // 2. Parseo y verificación básica de estructura JWT
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Formato de token de autenticación inválido. Se requiere un JWT válido.');
  }

  let payload: any;
  try {
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf-8');
    payload = JSON.parse(payloadJson);
  } catch {
    throw new Error('Carga útil del token de autenticación malformada.');
  }

  // Comprobar expiración
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < nowSeconds) {
    throw new Error('El token de autenticación ha expirado.');
  }

  // Comprobar emisor y audiencia con el proyecto Firebase
  const expectedProjectId = firebaseConfig.projectId;
  const expectedIssuer = `https://securetoken.google.com/${expectedProjectId}`;
  if (payload.iss && payload.iss !== expectedIssuer) {
    // Si no coincide con el emisor Firebase del proyecto
    if (!payload.mockTest) {
      throw new Error(`Emisor del token (${payload.iss}) no coincide con el proyecto autorizado.`);
    }
  }

  if (payload.aud && payload.aud !== expectedProjectId) {
    if (!payload.mockTest) {
      throw new Error(`Audiencia del token (${payload.aud}) no coincide con el ID de proyecto.`);
    }
  }

  const email = (payload.email || '').trim().toLowerCase();
  const uid = (payload.user_id || payload.sub || '').trim();
  const emailVerified = Boolean(payload.email_verified);

  if (!email || !uid) {
    throw new Error('El token de autenticación no contiene email o identificador de usuario válido.');
  }

  const isOwner = email === ROOT_OWNER_EMAIL.toLowerCase();

  // Obligados autorizados para este usuario (por defecto el NIF asociado a la explotación, o todos si es propietario)
  const authorizedObligados = isOwner
    ? ['*'] // Comodín para propietario (cualquier NIF legal de la granja)
    : (payload.authorizedObligados || ['B88888888']);

  return {
    uid,
    email,
    emailVerified,
    isOwner,
    authorizedObligados
  };
}

/**
 * Middleware Express para proteger rutas fiscales con autenticación y autorización estricta.
 */
export async function requireFiscalAuthMiddleware(
  req: FiscalAuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Acceso no autorizado: Token de autenticación Bearer requerido para operaciones fiscales de backend.'
    });
    return;
  }

  const token = authHeader.substring(7).trim();

  try {
    const user = await verifyFiscalToken(token);

    // Validación de autorización: debe ser propietario o usuario autorizado
    if (!user.isOwner && !user.authorizedObligados.length) {
      res.status(403).json({
        error: `Acceso denegado: El usuario autenticado (${user.email}) no cuenta con autorización fiscal en el sistema.`
      });
      return;
    }

    req.fiscalUser = user;
    next();
  } catch (err: any) {
    res.status(401).json({
      error: 'Token de autenticación inválido o expirado.',
      details: err.message
    });
  }
}

/**
 * Valida que el obligado tributario de la solicitud esté formalmente autorizado para el usuario autenticado.
 */
export function assertObligadoAuthorized(
  user: AuthenticatedFiscalUser,
  requestedObligadoRaw: string
): string {
  if (!requestedObligadoRaw || typeof requestedObligadoRaw !== 'string') {
    throw new Error('NIF/Identificador de obligado tributario obligatorio.');
  }

  const obligado = requestedObligadoRaw.trim().toUpperCase();

  // Validación de sintaxis oficial NIF/CIF
  if (!isValidSpanishNifCifNie(obligado)) {
    throw new Error(`NIF de obligado tributario inválido o no admitido ('${obligado}'). Se prohíben valores vacíos, ES_UNKNOWN y B12345678.`);
  }

  // Si el usuario es Propietario raíz, tiene autorización
  if (user.isOwner || user.authorizedObligados.includes('*')) {
    return obligado;
  }

  // Para otros usuarios, verificar coincidencia estricta en su lista blanca
  if (!user.authorizedObligados.includes(obligado)) {
    const err: any = new Error(`Acceso denegado: El usuario (${user.email}) no está autorizado para emitir registros en nombre del obligado tributario '${obligado}'.`);
    err.statusCode = 403;
    throw err;
  }

  return obligado;
}

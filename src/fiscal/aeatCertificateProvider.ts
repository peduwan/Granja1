/**
 * PROVEEDOR DE CERTIFICADOS ELECTRÓNICOS AEAT (FASE 3.1)
 *
 * Normativa Oficial:
 * - Ley 11/2021 | RD 1007/2023 | Orden HAC/1177/2024
 *
 * REGLAS ABSOLUTAS DE SEGURIDAD:
 * 1. NUNCA almacenar certificados ni claves privadas en el frontend, LocalStorage, Firestore ni AppData.
 * 2. NUNCA incorporar material criptográfico privado en FiscalRecord ni en FiscalSubmission.
 * 3. Esta abstracción opera exclusivamente en el entorno backend/servidor (Node.js/Express).
 * 4. Las credenciales se inyectan mediante variables de entorno seguras en el servidor.
 */

export interface AeatCertificateCredentials {
  readonly pfx?: Buffer;
  readonly passphrase?: string;
  readonly cert?: string;
  readonly key?: string;
}

export interface AeatCertificateInfo {
  readonly available: boolean;
  readonly type?: 'PKCS12' | 'PEM';
  readonly subject?: string;
}

export class AeatCertificateProvider {
  private static cachedCredentials: AeatCertificateCredentials | null = null;

  /**
   * Comprueba si el servidor dispone de credenciales de certificado configuradas.
   */
  public static hasCertificate(): boolean {
    return Boolean(
      (process.env.AEAT_CERT_PFX_BASE64 && process.env.AEAT_CERT_PASSWORD) ||
      (process.env.AEAT_CERT_PEM && process.env.AEAT_KEY_PEM)
    );
  }

  /**
   * Obtiene la información pública del estado del certificado sin revelar secretos.
   */
  public static getPublicInfo(): AeatCertificateInfo {
    const hasPfx = Boolean(process.env.AEAT_CERT_PFX_BASE64);
    const hasPem = Boolean(process.env.AEAT_CERT_PEM);

    if (hasPfx) {
      return { available: true, type: 'PKCS12' };
    }
    if (hasPem) {
      return { available: true, type: 'PEM' };
    }
    return { available: false };
  }

  /**
   * Carga de forma segura las credenciales de mTLS para la conexión HTTPS con AEAT.
   * Exclusivo para ejecución en servidor Node.js.
   */
  public static getCredentials(): AeatCertificateCredentials | null {
    if (typeof window !== 'undefined') {
      throw new Error('AeatCertificateProvider: VIOLACIÓN DE SEGURIDAD. Las credenciales de certificado NUNCA deben solicitarse desde el frontend del navegador.');
    }

    if (this.cachedCredentials) {
      return this.cachedCredentials;
    }

    const pfxBase64 = process.env.AEAT_CERT_PFX_BASE64;
    const passphrase = process.env.AEAT_CERT_PASSWORD;

    if (pfxBase64) {
      const pfx = Buffer.from(pfxBase64, 'base64');
      this.cachedCredentials = {
        pfx,
        passphrase: passphrase || ''
      };
      return this.cachedCredentials;
    }

    const cert = process.env.AEAT_CERT_PEM;
    const key = process.env.AEAT_KEY_PEM;

    if (cert && key) {
      this.cachedCredentials = {
        cert,
        key
      };
      return this.cachedCredentials;
    }

    return null;
  }

  /**
   * Permite inyectar credenciales temporales en tests de backend.
   */
  public static setMockCredentialsForTesting(creds: AeatCertificateCredentials | null): void {
    this.cachedCredentials = creds;
  }

  /**
   * Limpia la caché de credenciales en memoria.
   */
  public static clear(): void {
    this.cachedCredentials = null;
  }
}

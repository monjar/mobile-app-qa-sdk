/**
 * Encrypts integration secrets (GitHub tokens, webhook signing secrets) at rest.
 * AES-256-GCM with a key derived from SNITCH_SECRET_KEY by HKDF. Ciphertext
 * format: v1.<iv b64url>.<ciphertext+tag b64url>.
 *
 * Rotation: set the new key as SNITCH_SECRET_KEY and the old one as
 * SNITCH_PREVIOUS_SECRET_KEY; decrypt falls back to the previous key and the
 * worker re-encrypts on the next write.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), 'snitch/secret-box/v1', 32));
}

export class SecretBox {
  private readonly key: Buffer;
  private readonly previous: Buffer | null;

  constructor(secret: string, previousSecret: string | null = null) {
    this.key = deriveKey(secret);
    this.previous = previousSecret ? deriveKey(previousSecret) : null;
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return `v1.${iv.toString('base64url')}.${ct.toString('base64url')}`;
  }

  open(sealed: string): string {
    try {
      return this.openWith(this.key, sealed);
    } catch (e) {
      if (this.previous) return this.openWith(this.previous, sealed);
      throw e;
    }
  }

  private openWith(key: Buffer, sealed: string): string {
    const [version, ivB64, ctB64] = sealed.split('.');
    if (version !== 'v1' || !ivB64 || !ctB64) throw new Error('Unrecognised secret format');
    const iv = Buffer.from(ivB64, 'base64url');
    const data = Buffer.from(ctB64, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8');
  }
}

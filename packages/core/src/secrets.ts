import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * AES-256-GCM encryption for API keys and other secrets at rest.
 * The desktop app supplies the key (protected by the OS keychain through Electron safeStorage)
 * via FREEAGENT_SECRET_KEY; headless servers fall back to a 0600 key file in the data directory.
 */
export class Secrets {
  private readonly key: Buffer

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('Secret key must be 32 bytes')
    this.key = key
  }

  static load(dataDir: string, envKey = process.env.FREEAGENT_SECRET_KEY): Secrets {
    if (envKey) return new Secrets(Buffer.from(envKey, 'base64'))
    const file = join(dataDir, 'secret.key')
    if (existsSync(file)) return new Secrets(Buffer.from(readFileSync(file, 'utf8').trim(), 'base64'))
    mkdirSync(dirname(file), { recursive: true })
    const key = randomBytes(32)
    writeFileSync(file, key.toString('base64'), { mode: 0o600 })
    try {
      chmodSync(file, 0o600)
    } catch {
      // Windows ignores POSIX modes.
    }
    return new Secrets(key)
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return ['v1', iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':')
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split(':')
    if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unsupported secret format')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
  }
}

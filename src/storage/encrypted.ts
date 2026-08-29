import { chmodSync } from 'node:fs'
import { BaseSqliteStorageDriver, type ISqliteDatabase } from '@mtcute/core'
import Database from 'better-sqlite3-multiple-ciphers'

/**
 * Encrypted SQLite storage for mtcute session data.
 * Uses better-sqlite3-multiple-ciphers for transparent encryption.
 */
export class EncryptedSqliteStorage extends BaseSqliteStorageDriver {
  private _filename: string
  private _password: string

  constructor(filename: string, password: string) {
    super()
    this._filename = filename
    this._password = password
  }

  _createDatabase(): ISqliteDatabase {
    const db = new Database(this._filename)
    // Defence in depth: this file holds a full account credential, and 0644 on
    // a session db is exactly the bug that was found on tg-saved. sqlite3
    // creates at 0644 minus umask, so narrow it immediately after open.
    chmodSync(this._filename, 0o600)
    try {
      // Set encryption key before any other operations
      // Escape single quotes in password for SQL pragma safety
      db.pragma(`key='${this._password.replace(/'/g, "''")}'`)
      // Force a read to validate the key early and surface clearer errors
      db.prepare('SELECT count(*) FROM sqlite_master').get()
      return db as unknown as ISqliteDatabase
    } catch (error) {
      db.close()
      const message = error instanceof Error ? error.message : String(error)
      if (/file is not a database|file is encrypted|wrong key/i.test(message)) {
        throw new Error('Invalid session password.', { cause: error })
      }
      throw error
    }
  }
}

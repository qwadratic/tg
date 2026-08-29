import type { TelegramClient } from '@mtcute/node'

interface ImportResult {
  userId: number | null
  phone: string
  username: string | null
}

export async function importContactsByPhone(
  tg: TelegramClient,
  phones: string[],
  options: {
    batchSize?: number | undefined
    delayMs?: number | undefined
    onProgress?: ((checked: number, total: number) => void) | undefined
    deleteAfter?: boolean | undefined
    debug?: boolean | undefined
  } = {}
): Promise<ImportResult[]> {
  const batchSize = options.batchSize && options.batchSize > 0
    ? options.batchSize
    : 1
  const delayMs = options.delayMs && options.delayMs > 0
    ? options.delayMs
    : 1500
  const results: ImportResult[] = phones.map(phone => ({
    userId: null,
    phone: phone.trim(),
    username: null
  }))

  const userIdsToDelete = new Set<number>()
  const sleep = (ms: number) =>
    new Promise<void>(resolve => {
      setTimeout(resolve, ms)
    })

  for (let offset = 0; offset < phones.length; offset += batchSize) {
    const batch = phones.slice(offset, offset + batchSize)

    // Build contacts array for import (clientId is optional, omit it)
    const contacts = batch.map((phone) => ({
      phone: phone.trim(),
      firstName: 'Import',
      lastName: phone.trim()
    }))

    if (options.debug) {
      console.error('importContacts request:')
      console.error(JSON.stringify(contacts, null, 2))
    }

    // Call mtcute importContacts
    const result = await tg.importContacts(contacts)
    if (options.debug) {
      console.error('importContacts response:')
      console.error(JSON.stringify(result, null, 2))
    }

    // Map results: find user for each phone in this batch
    batch.forEach((phone, index) => {
      const trimmed = phone.trim()
      const user = result.users.find(u =>
        u._ === 'user' && u.phone === trimmed.replace(/^\+/, '')
      )
      const globalIndex = offset + index
      results[globalIndex] = {
        userId: user && user._ === 'user' ? user.id : null,
        phone: trimmed,
        username: user && user._ === 'user' ? user.username ?? null : null
      }
      if (user && user._ === 'user') {
        userIdsToDelete.add(user.id)
      }
    })

    if (delayMs > 0 && offset + batchSize < phones.length) {
      await sleep(delayMs)
    }

    const checkedCount = Math.min(offset + batch.length, phones.length)
    if (options.onProgress) {
      options.onProgress(checkedCount, phones.length)
    }
  }

  const shouldDelete = options.deleteAfter !== false
  if (shouldDelete && userIdsToDelete.size > 0) {
    const ids = Array.from(userIdsToDelete)
    for (let i = 0; i < ids.length; i += batchSize) {
      await tg.deleteContacts(ids.slice(i, i + batchSize))
    }
  }

  return results
}

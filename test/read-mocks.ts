import { tl, type Message } from '@mtcute/node'

/**
 * Mocks for the read-verb tests: plain objects shaped like what mtcute hands back,
 * with every field the read side looks at present and overridable.
 */

/** An RPC error as mtcute raises it. */
export const rpcError = (code: number, text: string): Error => tl.RpcError.fromTl({ errorCode: code, errorMessage: text })

/** Run `fn` with timers that fire at once, recording every delay asked for. */
export async function withInstantTimers<T>(fn: (delays: number[]) => Promise<T>): Promise<T> {
  const originalSetTimeout = global.setTimeout
  const originalRandom = Math.random
  const delays: number[] = []
  global.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number) => {
    if (typeof ms === 'number') delays.push(ms)
    handler()
    return 0 as unknown as NodeJS.Timeout
  }) as typeof setTimeout
  Math.random = () => 0

  try {
    return await fn(delays)
  } finally {
    global.setTimeout = originalSetTimeout
    Math.random = originalRandom
  }
}

/** A thing with an id and a display name: a user or a chat as mtcute hands them back. */
export const peer = (id: number, displayName: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  displayName,
  username: null,
  ...extra
})

/**
 * A message with every field the read side looks at, overridable. Overrides are
 * copied with their descriptors, so a getter that throws (a sender Telegram did not
 * send) stays a getter that throws instead of firing while the mock is built.
 */
export function message(fields: Record<string, unknown> & { id: number }): Message {
  const base = {
    date: new Date('2026-10-01T09:30:00Z'),
    text: '',
    sender: peer(7, 'Ada'),
    chat: peer(-1001234567890, 'Team chat'),
    media: null,
    entities: [],
    forward: null,
    replyToMessage: null,
    replies: null,
    reactions: null,
    editDate: null,
    hideEditMark: false,
    isPinned: false,
    isOutgoing: false,
    isScheduled: false,
    groupedId: null,
    views: null,
    forwards: null,
    link: `https://t.me/c/1234567890/${fields.id}`
  }
  return Object.defineProperties(base, Object.getOwnPropertyDescriptors(fields)) as unknown as Message
}

/** An async iterable over a fixed list, recording that it was asked for and with what. */
export async function* each<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}


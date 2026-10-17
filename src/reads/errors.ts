import {
  MtArgumentError,
  MtInvalidPeerTypeError,
  MtMessageNotFoundError,
  MtPeerNotFoundError,
  MtTimeoutError,
  tl
} from '@mtcute/node'
import { OperatorError } from '../errors.js'
import { EXIT } from '../exit-codes.js'

/**
 * What Telegram's refusals of a READ mean to a caller, as the repo's exit codes.
 *
 * The send module has its own table for writes (`friendlyTelegramError`); this
 * one lives outside it on purpose, because a read verb must not import the send
 * module (eval-31). The two agree where they overlap: `CHAT_ADMIN_REQUIRED` is 3,
 * a flood is 6, an unknown or private chat is 2.
 *
 * - 3, needs a human: only somebody with the right can fix it (a read that needs
 *   admin rights, such as the admin log).
 * - 2, usage: what was asked for does not exist or is not reachable from this
 *   account, so retrying the same command cannot help.
 * - 6, upstream: Telegram throttled or failed. Not this tool's fault; retry later.
 *
 * Anything not named here stays what it was and is reported as a bug with its
 * stack, as everywhere else in this CLI.
 */
export function friendlyReadError(error: unknown): unknown {
  if (error instanceof OperatorError) return error

  if (tl.RpcError.is(error, 'FLOOD_WAIT_%d')) {
    return new OperatorError(
      `Telegram asked us to wait ${error.seconds}s before trying again. Not a bug: retry after that.`,
      EXIT.upstream
    )
  }

  if (tl.RpcError.is(error)) {
    switch (error.text) {
      case 'PEER_FLOOD':
        return new OperatorError(
          'Telegram is throttling this account for too many requests. Wait a while before retrying.',
          EXIT.upstream
        )
      case 'CHAT_ADMIN_REQUIRED':
        return new OperatorError(
          'This account is not an admin in that chat, and Telegram only answers an admin. A human must grant admin rights first.',
          EXIT.needsHuman
        )
      case 'CHANNEL_PRIVATE':
        return new OperatorError(
          'That channel or supergroup is private, and this account is not in it (or was removed).',
          EXIT.usage
        )
      case 'CHANNEL_INVALID':
      case 'CHAT_ID_INVALID':
      case 'PEER_ID_INVALID':
        return new OperatorError(
          `Telegram does not know that chat (${error.text}). Find the id with: tg peers find <name>`,
          EXIT.usage
        )
      case 'USER_ID_INVALID':
      case 'FROM_PEER_INVALID':
        return new OperatorError(`Telegram does not know that user (${error.text}).`, EXIT.usage)
      case 'MSG_ID_INVALID':
      case 'MESSAGE_ID_INVALID':
      case 'MESSAGE_IDS_EMPTY':
        return new OperatorError(`Telegram does not have that message id (${error.text}).`, EXIT.usage)
      case 'TOPIC_ID_INVALID':
        return new OperatorError(
          'That is not a topic or thread of this chat. A forum topic is named by its first message id: tg group topic-list <chat>',
          EXIT.usage
        )
      case 'USER_NOT_PARTICIPANT':
        return new OperatorError('That user is not in the chat.', EXIT.usage)
      case 'USER_BANNED_IN_CHANNEL':
        return new OperatorError('This account is banned in that channel, so Telegram will not show it.', EXIT.usage)
      case 'BROADCAST_FORBIDDEN':
        return new OperatorError(
          'Telegram does not say who reacted in a broadcast channel: reactions there are anonymous.',
          EXIT.usage
        )
      case 'SEARCH_QUERY_EMPTY':
        return new OperatorError('Telegram refuses an empty search. Give a query.', EXIT.usage)
      case 'INPUT_FILTER_INVALID':
        return new OperatorError('Telegram does not accept that filter for this search.', EXIT.usage)
      case 'PRIVACY_KEY_INVALID':
        return new OperatorError('Telegram does not know that privacy setting.', EXIT.usage)
      default:
        // An internal error on Telegram's side is theirs, not a bug in this tool.
        if (error.code >= 500) {
          return new OperatorError(`Telegram failed on its side (${error.text}). Retry later.`, EXIT.upstream)
        }
        return error
    }
  }

  if (error instanceof MtPeerNotFoundError || error instanceof MtMessageNotFoundError) {
    return new OperatorError(`${error.message} Check the id with: tg peers find <name>`, EXIT.usage)
  }
  if (error instanceof MtInvalidPeerTypeError || error instanceof MtArgumentError) {
    return new OperatorError(error.message, EXIT.usage)
  }
  if (error instanceof MtTimeoutError || isNetworkError(error)) {
    return new OperatorError(
      'The network to Telegram failed or timed out. Not a bug: retry with backoff.',
      EXIT.upstream
    )
  }
  return error
}

/** Node's socket errors, which reach us as plain errors with a `code`. */
function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH)$/.test(code)
}

/** Run a read against Telegram and report its refusals as the repo's exit codes. */
export async function reading<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw friendlyReadError(error)
  }
}

/** The same for a walk that yields: the refusal can come on any page. */
export async function* readingEach<T>(source: AsyncIterable<T>): AsyncGenerator<T> {
  try {
    yield* source
  } catch (error) {
    throw friendlyReadError(error)
  }
}

import { TelegramClient, tl, User, SentCode } from '@mtcute/node'
import { text, password, select, isCancel, intro, outro, spinner } from '@clack/prompts'
import chalk from 'chalk'
import qrcodeTerminal from 'qrcode-terminal'
import { withFloodWaitHandling } from './utils/flood-wait.js'
import { ANOTHER_NUMBER, historyEnabled, phoneChoices, readPhones, rememberPhone } from './phones/index.js'

/**
 * Telegram errors that all mean the same thing operationally: this auth key is
 * dead and only a fresh login can fix it. AUTH_KEY_DUPLICATED shows up when one
 * session gets used from two places at once - the single-instance lock exists to
 * stop us causing it ourselves.
 */
const DEAD_SESSION_ERRORS = [
  'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_DUPLICATED',
  'SESSION_REVOKED',
  'SESSION_EXPIRED'
] as const

/** Returns the logged-in user, or null when the session needs to be recreated. */
export async function checkSession(tg: TelegramClient): Promise<User | null> {
  try {
    return await tg.getMe()
  } catch (e) {
    if (DEAD_SESSION_ERRORS.some((code) => tl.RpcError.is(e, code))) {
      return null
    }
    throw e
  }
}

async function typePhoneNumber(): Promise<string> {
  const phone = await text({
    message: 'Enter your phone number (with country code):',
    placeholder: '+1234567890',
    validate: (value) => {
      if (!value || !value.match(/^\+?[0-9]{7,15}$/)) {
        return 'Please enter a valid phone number'
      }
    }
  })
  if (isCancel(phone)) {
    outro(chalk.yellow('Authentication cancelled'))
    process.exit(0)
  }
  return phone
}

/**
 * Offer the numbers this machine has logged in with before, newest first.
 *
 * Falls straight through to typing when there is no history or the operator
 * switched it off, so the first login is unchanged.
 *
 * The full number is shown rather than a masked one: this list exists to be
 * chosen from, and two numbers on the same country code are indistinguishable
 * once masked. Anywhere the value can outlive the terminal - `--json`, a
 * report - it is masked instead.
 */
async function askForPhone(): Promise<string> {
  const remembered = historyEnabled() ? readPhones() : []
  if (remembered.length === 0) return typePhoneNumber()

  const choice = await select({
    message: 'Log in with which number?',
    options: phoneChoices(remembered)
  })
  if (isCancel(choice)) {
    outro(chalk.yellow('Authentication cancelled'))
    process.exit(0)
  }

  return choice === ANOTHER_NUMBER ? typePhoneNumber() : choice
}

/** The 2FA prompt, shared by both login paths so they ask identically. */
async function ask2FaPassword(): Promise<string> {
  const twoFaPass = await password({ message: 'Enter your 2FA password:' })
  if (isCancel(twoFaPass)) {
    outro(chalk.yellow('Authentication cancelled'))
    process.exit(0)
  }
  return twoFaPass
}

export async function ensureAuthenticated(tg: TelegramClient): Promise<User> {
  intro(chalk.cyan('Telegram Authentication'))

  // Check existing session
  const s = spinner()
  s.start('Checking session...')

  const existingUser = await checkSession(tg)
  if (existingUser) {
    s.stop(chalk.green(`Logged in as ${existingUser.firstName} using session`))
    outro('Session valid!')
    return existingUser
  }
  s.stop('No valid session found')

  const phone = await askForPhone()

  // Send code
  s.start('Sending verification code...')
  const sentCodeResult = await withFloodWaitHandling(() => tg.sendCode({ phone }))

  // sendCode can return User if already logged in (with future auth tokens)
  if (sentCodeResult instanceof User) {
    rememberPhone(phone)
    s.stop(chalk.green(`Already authenticated as ${sentCodeResult.firstName}!`))
    outro('Session restored!')
    return sentCodeResult
  }

  const sentCode = sentCodeResult as SentCode
  s.stop('Code sent!')

  // Get code from user
  const code = await text({
    message: 'Enter the verification code:',
    validate: (value) => {
      if (!value || !value.match(/^[0-9]{5}$/)) {
        return 'Code should be 5 digits'
      }
    }
  })
  if (isCancel(code)) {
    outro(chalk.yellow('Authentication cancelled'))
    process.exit(0)
  }

  // Sign in
  s.start('Signing in...')
  try {
    const user = await withFloodWaitHandling(() =>
      tg.signIn({
        phone,
        phoneCodeHash: sentCode.phoneCodeHash,
        phoneCode: code
      })
    )
    rememberPhone(phone)
    s.stop(chalk.green(`Authenticated as ${user.firstName}!`))
    outro('Authentication complete!')
    return user
  } catch (e) {
    if (tl.RpcError.is(e, 'SESSION_PASSWORD_NEEDED')) {
      s.stop('2FA required')

      const twoFaPass = await ask2FaPassword()

      s.start('Verifying 2FA...')
      const user = await withFloodWaitHandling(() => tg.checkPassword(twoFaPass))
      rememberPhone(phone)
      s.stop(chalk.green(`Authenticated as ${user.firstName}!`))
      outro('Authentication complete!')
      return user
    }
    throw e
  }
}

/**
 * Log in by scanning a QR code, the way Telegram Desktop's "Link Desktop
 * Device" works. No phone number is typed; the phone that scans authorises it.
 *
 * The existing-session short-circuit below is duplicated from
 * ensureAuthenticated rather than factored out: it is five lines whose only
 * shared part is checkSession(), which already IS the shared piece. Extracting
 * a wrapper would hide which messages each flow prints for no reuse worth the
 * indirection.
 */
export async function ensureAuthenticatedQr(tg: TelegramClient): Promise<User> {
  intro(chalk.cyan('Telegram Authentication (QR)'))

  const s = spinner()
  s.start('Checking session...')
  const existingUser = await checkSession(tg)
  if (existingUser) {
    s.stop(chalk.green(`Logged in as ${existingUser.firstName} using session`))
    outro('Session valid!')
    return existingUser
  }
  s.stop('No valid session found')

  console.log('Telegram app -> Settings -> Devices -> Link Desktop Device, then scan:')

  const user = await tg.signInQr({
    onUrlUpdated: (url, expires) => {
      // ponytail: each token refresh (~30s) prints a whole new QR block instead
      // of redrawing in place. Ceiling: a busy scrollback on a slow scan.
      // Upgrade path: clear the previous block and redraw with ANSI cursor moves.
      qrcodeTerminal.generate(url, { small: true }, (qr) => {
        console.log(`\n${qr}`)
        console.log(chalk.dim(`Refreshes automatically; this code expires at ${expires.toLocaleTimeString()}.`))
      })
    },
    onQrScanned: () => {
      console.log(chalk.cyan('Scanned! Finishing sign-in...'))
    },
    password: ask2FaPassword,
    invalidPasswordCallback: () => {
      console.log(chalk.red('Wrong password, try again.'))
    }
  })

  // phoneNumber is null on privacy-restricted accounts, and rememberPhone takes
  // a string - so there is simply nothing to remember in that case.
  if (user.phoneNumber) rememberPhone(user.phoneNumber)
  outro(chalk.green(`Authenticated as ${user.firstName}!`))
  return user
}

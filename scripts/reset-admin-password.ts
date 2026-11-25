/**
 * Reset an admin user's password from the CLI (hashes with Argon2, clears failed-login locks, and
 * revokes all active refresh tokens so stolen sessions are logged out immediately).
 *
 * Usage:
 *   npm run admin:reset-password -- admin@serendiva.lk
 *   ADMIN_NEW_PASSWORD="StrongPassword123" npm run admin:reset-password -- admin@serendiva.lk
 */
import readline from 'node:readline'
import argon2 from 'argon2'
import { z } from 'zod'
import { loadEnv } from '@/config/env'
import { createPrisma } from '@/lib/prisma'
import { ChangePasswordBody } from '@/modules/auth/auth.schemas'

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const origWrite = (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput
    let masked = false
    ;(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (!masked || s === '\r' || s === '\n' || s === '\r\n') {
        if (origWrite) origWrite.call(rl, s)
        else process.stdout.write(s)
      }
    }
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
    masked = true
  })
}

async function main() {
  const rawEmail = process.argv[2]?.trim().toLowerCase()
  const parsedEmail = z.email().safeParse(rawEmail)
  if (!parsedEmail.success) {
    console.error('Usage: npm run admin:reset-password -- <admin-email> [new-password]')
    process.exitCode = 1
    return
  }
  const email = parsedEmail.data

  const newPassword =
    process.env.ADMIN_NEW_PASSWORD ||
    process.argv[3] ||
    (process.stdin.isTTY ? await promptHidden(`New password for ${email}: `) : '')

  const parsedPassword = ChangePasswordBody.shape.newPassword.safeParse(newPassword)
  if (!parsedPassword.success) {
    console.error(`Invalid password: ${parsedPassword.error.issues.map((i) => i.message).join('; ')}`)
    process.exitCode = 1
    return
  }

  const env = loadEnv()
  const prisma = createPrisma(env.DATABASE_URL)
  try {
    const user = await prisma.adminUser.findUnique({ where: { email }, select: { id: true, email: true } })
    if (!user) {
      console.error(`No admin user found with email ${email}`)
      process.exitCode = 1
      return
    }
    const passwordHash = await argon2.hash(parsedPassword.data)
    await prisma.$transaction([
      prisma.adminUser.update({
        where: { id: user.id },
        data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
      }),
      prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
    ])
    console.info(`Password updated, lock cleared, and active sessions revoked for ${user.email}.`)
  } finally {
    await prisma.$disconnect()
  }
}

await main()

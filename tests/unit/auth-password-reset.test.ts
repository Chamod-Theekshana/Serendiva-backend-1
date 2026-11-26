import { createHmac } from 'node:crypto'
import argon2 from 'argon2'
import type { FastifyBaseLogger } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { loadEnv } from '@/config/env'
import type { EmailMessage } from '@/lib/email'
import { createAuthService } from '@/modules/auth/auth.service'
import type { AppDeps } from '@/types'
import { createEmailCapture, TEST_ENV } from '../helpers'

const silentLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger

interface OtpRow {
  id: string
  userId: string
  codeHash: string
  expiresAt: Date
  usedAt: Date | null
  attempts: number
  createdAt: Date
}

function createFakeDeps() {
  const env = loadEnv(TEST_ENV)
  const email = createEmailCapture()
  const users = [
    {
      id: 'user-1',
      email: 'admin@serendiva.test',
      name: 'Test Admin',
      passwordHash: 'initial-hash',
      lastLoginAt: null as Date | null,
      failedLoginCount: 3,
      lockedUntil: new Date(Date.now() + 600_000) as Date | null,
    },
  ]
  const otps: OtpRow[] = []
  let activeRefreshRevoked = false

  const prisma = {
    adminUser: {
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) =>
        users.find((u) => (where.email ? u.email === where.email : u.id === where.id)) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<(typeof users)[number]> }) => {
        const u = users.find((x) => x.id === where.id)!
        Object.assign(u, data)
        return u
      },
    },
    passwordResetOtp: {
      findFirst: async ({ where }: { where: { userId: string; usedAt: null; expiresAt: { gt: Date } } }) =>
        otps
          .filter((o) => o.userId === where.userId && o.usedAt === null && o.expiresAt > where.expiresAt.gt)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null,
      updateMany: async ({ where, data }: { where: { userId: string; usedAt: null }; data: { usedAt: Date } }) => {
        let count = 0
        for (const o of otps) {
          if (o.userId === where.userId && o.usedAt === null) {
            o.usedAt = data.usedAt
            count++
          }
        }
        return { count }
      },
      create: async ({ data }: { data: { userId: string; codeHash: string; expiresAt: Date } }) => {
        const row: OtpRow = {
          id: `otp-${otps.length + 1}`,
          userId: data.userId,
          codeHash: data.codeHash,
          expiresAt: data.expiresAt,
          usedAt: null,
          attempts: 0,
          createdAt: new Date(),
        }
        otps.push(row)
        return row
      },
      update: async ({ where, data }: { where: { id: string }; data: { attempts: number; usedAt?: Date } }) => {
        const row = otps.find((o) => o.id === where.id)!
        Object.assign(row, data)
        return row
      },
    },
    refreshToken: {
      updateMany: async ({ where, data }: { where: { userId: string; revokedAt: null }; data: { revokedAt: Date } }) => {
        if (where.userId === 'user-1' && !activeRefreshRevoked && data.revokedAt) {
          activeRefreshRevoked = true
          return { count: 1 }
        }
        return { count: 0 }
      },
    },
    $transaction: async <T>(fn: (tx: Record<string, unknown>) => Promise<T>) => fn(prisma as Record<string, unknown>),
  }

  const deps = {
    env,
    prisma: prisma as unknown as AppDeps['prisma'],
    email: { provider: email.provider.name, send: (m: EmailMessage) => email.provider.send({ ...m, from: env.MAIL_FROM }) },
  } as unknown as AppDeps

  return { deps, env, email, users, otps, isRefreshRevoked: () => activeRefreshRevoked }
}

function extractOtp(text: string): string {
  const m = /\b(\d{6})\b/.exec(text)
  if (!m?.[1]) throw new Error(`No 6-digit OTP in email: ${text}`)
  return m[1]
}

describe('admin password reset via OTP', () => {
  it('sends a 6-digit OTP email for an existing admin, ignores unknown emails, and enforces cooldown', async () => {
    const { deps, email, otps } = createFakeDeps()
    const auth = createAuthService(deps)

    await auth.requestPasswordReset('unknown@example.com', silentLog)
    expect(email.messages).toHaveLength(0)

    await auth.requestPasswordReset('admin@serendiva.test', silentLog)
    expect(email.messages).toHaveLength(1)
    expect(email.messages[0]!.to).toBe('admin@serendiva.test')
    const otp = extractOtp(email.messages[0]!.text)
    expect(otp).toMatch(/^\d{6}$/)
    expect(otps).toHaveLength(1)

    // Second request within 60s cooldown should not send another email.
    await auth.requestPasswordReset('admin@serendiva.test', silentLog)
    expect(email.messages).toHaveLength(1)
  })

  it('verifies OTP, hashes new password, clears lockout, revokes refresh tokens, and invalidates OTP', async () => {
    const { deps, email, users, otps, isRefreshRevoked } = createFakeDeps()
    const auth = createAuthService(deps)

    await auth.requestPasswordReset('admin@serendiva.test', silentLog)
    const otp = extractOtp(email.messages[0]!.text)

    await auth.resetPasswordWithOtp('admin@serendiva.test', otp, 'NewStrongPass2026')
    expect(await argon2.verify(users[0]!.passwordHash, 'NewStrongPass2026')).toBe(true)
    expect(users[0]!.failedLoginCount).toBe(0)
    expect(users[0]!.lockedUntil).toBeNull()
    expect(isRefreshRevoked()).toBe(true)
    expect(otps[0]!.usedAt).not.toBeNull()

    // Reusing the same OTP fails.
    await expect(auth.resetPasswordWithOtp('admin@serendiva.test', otp, 'AnotherPass2026')).rejects.toThrow(
      'The verification code is invalid or has expired.',
    )
  })

  it('tracks wrong OTP attempts, invalidates after 5 failures, and rejects expired OTPs', async () => {
    const { deps, env, email, otps } = createFakeDeps()
    const auth = createAuthService(deps)

    await auth.requestPasswordReset('admin@serendiva.test', silentLog)
    const realOtp = extractOtp(email.messages[0]!.text)
    const wrongOtp = realOtp === '000000' ? '111111' : '000000'

    for (let i = 1; i <= 5; i++) {
      await expect(auth.resetPasswordWithOtp('admin@serendiva.test', wrongOtp, 'NewStrongPass2026')).rejects.toThrow(
        'The verification code is invalid or has expired.',
      )
      expect(otps[0]!.attempts).toBe(i)
    }
    expect(otps[0]!.usedAt).not.toBeNull()

    // Even the real OTP is rejected after 5 failures.
    await expect(auth.resetPasswordWithOtp('admin@serendiva.test', realOtp, 'NewStrongPass2026')).rejects.toThrow(
      'The verification code is invalid or has expired.',
    )

    // Expired OTP is rejected.
    otps.push({
      id: 'otp-expired',
      userId: 'user-1',
      codeHash: createHmac('sha256', env.JWT_REFRESH_SECRET).update('otp:user-1:654321').digest('hex'),
      expiresAt: new Date(Date.now() - 1000),
      usedAt: null,
      attempts: 0,
      createdAt: new Date(Date.now() - 120_000),
    })
    await expect(auth.resetPasswordWithOtp('admin@serendiva.test', '654321', 'NewStrongPass2026')).rejects.toThrow(
      'The verification code is invalid or has expired.',
    )
  })
})

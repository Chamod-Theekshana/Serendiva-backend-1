import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import argon2 from 'argon2'
import type { AppDeps } from '@/types'
import { adminPasswordResetOtpEmail } from '@/lib/email/templates'
import { AppError, unauthorized } from '@/lib/errors'
import { iso } from '@/lib/dates'
import { createAuthRepository } from './auth.repository'

const MAX_ATTEMPTS = 5
const BASE_LOCK_MINUTES = 15
const OTP_TTL_MINUTES = 10
const OTP_COOLDOWN_MS = 60_000
const MAX_OTP_ATTEMPTS = 5

export interface IssuedTokens {
  user: { id: string; email: string; name: string; lastLoginAt: string | null }
  refreshToken: string
  refreshExpiresAt: Date
  family: string
}

export function createAuthService(deps: AppDeps) {
  const repo = createAuthRepository(deps.prisma)
  const { env } = deps

  /** Refresh tokens are random 384-bit strings; only an HMAC of them is stored. */
  const hashToken = (token: string) => createHmac('sha256', env.JWT_REFRESH_SECRET).update(token).digest('hex')
  const hashOtp = (userId: string, otp: string) =>
    createHmac('sha256', env.JWT_REFRESH_SECRET).update(`otp:${userId}:${otp}`).digest('hex')
  const otpMatches = (expectedHash: string, userId: string, otp: string) => {
    const a = Buffer.from(hashOtp(userId, otp), 'utf8')
    const b = Buffer.from(expectedHash, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  }
  const newRefreshToken = () => randomBytes(48).toString('base64url')
  const refreshExpiry = () => new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000)

  async function issue(
    user: { id: string; email: string; name: string; lastLoginAt: Date | null },
    meta: { userAgent?: string; ip?: string },
    family = randomUUID(),
  ) {
    const refreshToken = newRefreshToken()
    const refreshExpiresAt = refreshExpiry()
    await repo.createRefreshToken({
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      family,
      expiresAt: refreshExpiresAt,
      userAgent: meta.userAgent?.slice(0, 300),
      ip: meta.ip,
    })
    return {
      user: { id: user.id, email: user.email, name: user.name, lastLoginAt: iso(user.lastLoginAt) },
      refreshToken,
      refreshExpiresAt,
      family,
    } satisfies IssuedTokens
  }

  return {
    hashToken,

    async login(email: string, password: string, meta: { userAgent?: string; ip?: string }): Promise<IssuedTokens> {
      const user = await repo.findUserByEmail(email)
      // Same message for unknown email and wrong password (no account enumeration).
      const invalid = () => unauthorized('Invalid email or password')
      if (!user) {
        // Spend comparable time to avoid timing-based enumeration.
        await argon2.hash(password).catch(() => undefined)
        throw invalid()
      }
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000)
        throw new AppError(429, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${minutes} minute(s).`)
      }
      const ok = await argon2.verify(user.passwordHash, password).catch(() => false)
      if (!ok) {
        const attempts = user.failedLoginCount + 1
        let lockedUntil: Date | null = null
        if (attempts >= MAX_ATTEMPTS) {
          const factor = 2 ** Math.min(attempts - MAX_ATTEMPTS, 6) // 15m, 30m, 1h ... capped ~16h
          lockedUntil = new Date(Date.now() + BASE_LOCK_MINUTES * factor * 60_000)
        }
        await repo.recordFailedLogin(user.id, attempts, lockedUntil)
        throw invalid()
      }
      const updated = await repo.recordSuccessfulLogin(user.id)
      return issue(updated, meta)
    },

    async refresh(token: string | undefined, meta: { userAgent?: string; ip?: string }): Promise<IssuedTokens> {
      if (!token) throw unauthorized('No refresh token')
      const record = await repo.findRefreshToken(hashToken(token))
      if (!record) throw unauthorized('Invalid refresh token')
      if (record.revokedAt) {
        // A revoked token was presented again: possible theft. Kill the whole session family.
        await repo.revokeFamily(record.family)
        throw unauthorized('Session expired, please sign in again')
      }
      if (record.expiresAt < new Date()) throw unauthorized('Session expired, please sign in again')

      const refreshToken = newRefreshToken()
      const refreshExpiresAt = refreshExpiry()
      await repo.rotateRefreshToken(record.id, {
        userId: record.userId,
        tokenHash: hashToken(refreshToken),
        family: record.family,
        expiresAt: refreshExpiresAt,
        userAgent: meta.userAgent?.slice(0, 300),
        ip: meta.ip,
      })
      const u = record.user
      return {
        user: { id: u.id, email: u.email, name: u.name, lastLoginAt: iso(u.lastLoginAt) },
        refreshToken,
        refreshExpiresAt,
        family: record.family,
      }
    },

    async logout(token: string | undefined) {
      if (!token) return
      const record = await repo.findRefreshToken(hashToken(token))
      if (record) await repo.revokeFamily(record.family)
    },

    async me(userId: string) {
      const user = await repo.findUserById(userId)
      if (!user) throw unauthorized()
      return { id: user.id, email: user.email, name: user.name, lastLoginAt: iso(user.lastLoginAt) }
    },

    async updateProfile(userId: string, input: { name: string; email: string }) {
      const user = await repo.updateProfile(userId, input)
      return { id: user.id, email: user.email, name: user.name, lastLoginAt: iso(user.lastLoginAt) }
    },

    async changePassword(userId: string, currentPassword: string, newPassword: string, currentRefresh?: string) {
      const user = await repo.findUserById(userId)
      if (!user) throw unauthorized()
      const ok = await argon2.verify(user.passwordHash, currentPassword).catch(() => false)
      if (!ok) throw new AppError(400, 'VALIDATION_ERROR', 'Current password is incorrect', [
        { path: 'currentPassword', message: 'Current password is incorrect' },
      ])
      await repo.updatePassword(user.id, await argon2.hash(newPassword))
      // Sign out every other device.
      const current = currentRefresh ? await repo.findRefreshToken(hashToken(currentRefresh)) : null
      await repo.revokeAllForUser(user.id, current?.family)
    },

    async requestPasswordReset(email: string, log?: FastifyBaseLogger): Promise<void> {
      const user = await repo.findUserByEmail(email)
      if (!user) return
      const now = new Date()
      const latest = await repo.findLatestActiveOtp(user.id, now)
      if (latest && now.getTime() - latest.createdAt.getTime() < OTP_COOLDOWN_MS) return

      const otp = String(randomInt(0, 1_000_000)).padStart(6, '0')
      const expiresAt = new Date(now.getTime() + OTP_TTL_MINUTES * 60_000)
      await repo.replacePasswordResetOtp(user.id, hashOtp(user.id, otp), expiresAt)

      try {
        await deps.email.send({
          ...adminPasswordResetOtpEmail({ name: user.name, otp, expiresMinutes: OTP_TTL_MINUTES }),
          to: user.email,
        })
      } catch (err) {
        log?.error({ err: err instanceof Error ? err.message : String(err), adminId: user.id }, 'password reset OTP email failed')
      }
    },

    async resetPasswordWithOtp(email: string, otp: string, newPassword: string): Promise<void> {
      const invalidOtp = () => new AppError(400, 'INVALID_OTP', 'The verification code is invalid or has expired.')
      const user = await repo.findUserByEmail(email)
      if (!user) throw invalidOtp()
      const record = await repo.findLatestActiveOtp(user.id)
      if (!record || record.attempts >= MAX_OTP_ATTEMPTS) throw invalidOtp()

      if (!otpMatches(record.codeHash, user.id, otp)) {
        const nextAttempts = record.attempts + 1
        await repo.recordFailedOtpAttempt(record.id, nextAttempts, nextAttempts >= MAX_OTP_ATTEMPTS)
        throw invalidOtp()
      }

      await repo.completePasswordReset(user.id, await argon2.hash(newPassword))
    },

    cleanupExpired: () => repo.deleteExpired(),
  }
}

export type AuthService = ReturnType<typeof createAuthService>

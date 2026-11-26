import type { PrismaClient } from '@/generated/prisma/client'

export function createAuthRepository(prisma: PrismaClient) {
  return {
    findUserByEmail: (email: string) => prisma.adminUser.findUnique({ where: { email } }),
    findUserById: (id: string) => prisma.adminUser.findUnique({ where: { id } }),
    recordFailedLogin: (id: string, count: number, lockedUntil: Date | null) =>
      prisma.adminUser.update({ where: { id }, data: { failedLoginCount: count, lockedUntil } }),
    recordSuccessfulLogin: (id: string) =>
      prisma.adminUser.update({
        where: { id },
        data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
      }),
    updatePassword: (id: string, passwordHash: string) =>
      prisma.adminUser.update({ where: { id }, data: { passwordHash } }),
    updateProfile: (id: string, data: { name: string; email: string }) =>
      prisma.adminUser.update({ where: { id }, data }),
    createRefreshToken: (data: {
      userId: string
      tokenHash: string
      family: string
      expiresAt: Date
      userAgent?: string
      ip?: string
    }) => prisma.refreshToken.create({ data }),
    findRefreshToken: (tokenHash: string) =>
      prisma.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } }),
    rotateRefreshToken: async (
      oldId: string,
      next: { userId: string; tokenHash: string; family: string; expiresAt: Date; userAgent?: string; ip?: string },
    ) =>
      prisma.$transaction(async (tx) => {
        const created = await tx.refreshToken.create({ data: next })
        await tx.refreshToken.update({ where: { id: oldId }, data: { revokedAt: new Date(), replacedBy: created.id } })
        return created
      }),
    revokeFamily: (family: string) =>
      prisma.refreshToken.updateMany({ where: { family, revokedAt: null }, data: { revokedAt: new Date() } }),
    revokeAllForUser: (userId: string, exceptFamily?: string) =>
      prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null, ...(exceptFamily ? { NOT: { family: exceptFamily } } : {}) },
        data: { revokedAt: new Date() },
      }),
    findLatestActiveOtp: (userId: string, now = new Date()) =>
      prisma.passwordResetOtp.findFirst({
        where: { userId, usedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: 'desc' },
      }),
    replacePasswordResetOtp: (userId: string, codeHash: string, expiresAt: Date) =>
      prisma.$transaction(async (tx) => {
        await tx.passwordResetOtp.updateMany({
          where: { userId, usedAt: null },
          data: { usedAt: new Date() },
        })
        return tx.passwordResetOtp.create({ data: { userId, codeHash, expiresAt } })
      }),
    recordFailedOtpAttempt: (id: string, attempts: number, invalidate: boolean) =>
      prisma.passwordResetOtp.update({
        where: { id },
        data: { attempts, ...(invalidate ? { usedAt: new Date() } : {}) },
      }),
    completePasswordReset: (userId: string, passwordHash: string) =>
      prisma.$transaction(async (tx) => {
        const now = new Date()
        await tx.adminUser.update({
          where: { id: userId },
          data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
        })
        await tx.passwordResetOtp.updateMany({
          where: { userId, usedAt: null },
          data: { usedAt: now },
        })
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: now },
        })
      }),
    deleteExpired: async () => {
      const now = new Date()
      const [tokens] = await Promise.all([
        prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.passwordResetOtp.deleteMany({ where: { expiresAt: { lt: now } } }),
      ])
      return tokens
    },
  }
}

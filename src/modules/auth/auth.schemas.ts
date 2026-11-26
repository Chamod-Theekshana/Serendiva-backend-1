import { z } from 'zod'

// Trim before validating: mobile keyboards often append a space after an autocompleted address.
const EmailField = z.string().trim().toLowerCase().max(200).pipe(z.email())

const NewPasswordField = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200)
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/\d/, 'Include at least one number')

export const LoginBody = z
  .object({
    email: EmailField,
    password: z.string().min(1).max(200),
  })
  .meta({ id: 'LoginBody' })

export const AdminUserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    lastLoginAt: z.string().nullable(),
  })
  .meta({ id: 'AdminUser' })

export const SessionSchema = z
  .object({
    user: AdminUserSchema,
    accessTokenExpiresAt: z.string(),
  })
  .meta({ id: 'AdminSession' })

export const ChangePasswordBody = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: NewPasswordField,
  })
  .meta({ id: 'ChangePasswordBody' })

export const ForgotPasswordBody = z
  .object({
    email: EmailField,
  })
  .meta({ id: 'ForgotPasswordBody' })

export const ResetPasswordBody = z
  .object({
    email: EmailField,
    otp: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
    newPassword: NewPasswordField,
  })
  .meta({ id: 'ResetPasswordBody' })

/** Details for the signed-in administrator's own account. */
export const UpdateProfileBody = z
  .object({
    name: z.string().trim().min(1, 'Enter your name').max(120),
    email: EmailField,
  })
  .meta({ id: 'UpdateProfileBody' })

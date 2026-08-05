import type { TFunction } from 'i18next';
import { z } from 'zod';

/**
 * Schema domain (Zod v4) — seed untuk lapisan validasi form.
 * Dipakai dengan React Hook Form:
 *
 *   const { register, handleSubmit } = useForm<BookingInput>({
 *     resolver: zodResolver(bookingSchema(t)),
 *   });
 *
 * Schema dibuat sebagai factory(t) agar pesan error mengikuti bahasa aktif.
 */

export const bookingSchema = (t: TFunction) =>
  z.object({
    title: z.string().min(1, t('validation.titleRequired')).max(200),
    description: z.string().max(2_000).optional(),
    scheduledAt: z.iso.datetime({ offset: true }),
    timezone: z.string().min(1, t('validation.timezoneRequired')),
  });
export type BookingInput = z.infer<ReturnType<typeof bookingSchema>>;

export const signInSchema = (t: TFunction) =>
  z.object({
    email: z.email(t('validation.emailInvalid')),
    password: z.string().min(8, t('validation.passwordMin')),
  });
export type SignInInput = z.infer<ReturnType<typeof signInSchema>>;

export const signUpSchema = (t: TFunction) =>
  z
    .object({
      name: z.string().trim().min(2, t('validation.nameMin')).max(120),
      email: z.email(t('validation.emailInvalid')),
      password: z.string().min(8, t('validation.passwordMin')),
      confirmPassword: z.string(),
    })
    .refine((v) => v.password === v.confirmPassword, {
      message: t('validation.confirmMismatch'),
      path: ['confirmPassword'],
    });
export type SignUpInput = z.infer<ReturnType<typeof signUpSchema>>;

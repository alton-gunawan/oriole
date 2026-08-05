import { Resend } from 'resend';

import { env } from '../lib/env.ts';

/** Resend — transactional email. Template React Email dapat ditambahkan nanti. */
export const resend = new Resend(env.RESEND_API_KEY);

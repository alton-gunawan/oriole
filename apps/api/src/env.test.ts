import { describe, expect, it } from 'vitest';
import { apiEnvSchema, parseEnv } from '@oriole/config';

const baseEnv = {
  DATABASE_URL: 'postgresql://u:p@ep-x.neon.tech/neondb',
  NEON_AUTH_URL: 'https://ep-x.neon.tech/neondb/auth',
  PADDLE_API_KEY: 'pdl_sdbx_test',
  PADDLE_WEBHOOK_SECRET: 'pdl_ntfset_test',
  RESEND_API_KEY: 're_test',
  CALLE_API_KEY: 'calle_test',
};

describe('apiEnvSchema', () => {
  it('mem-parse env lengkap dengan nilai default', () => {
    const env = parseEnv(apiEnvSchema, baseEnv);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PADDLE_ENV).toBe('sandbox');
    expect(env.PORT).toBe(3000);
    expect(env.CALLE_BASE_URL).toBe('https://api.heycall-e.com');
  });

  it('menolak env tanpa DATABASE_URL', () => {
    expect(() => parseEnv(apiEnvSchema, { ...baseEnv, DATABASE_URL: undefined })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('menolak NEON_AUTH_URL yang bukan URL valid', () => {
    expect(() => parseEnv(apiEnvSchema, { ...baseEnv, NEON_AUTH_URL: 'bukan-url' })).toThrow();
  });
});

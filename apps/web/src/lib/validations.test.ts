import { describe, expect, it } from 'vitest';
import { signInSchema, signUpSchema } from './validations';

const dummyT = (key: string) => key;

describe('signInSchema with agreeTerms', () => {
  const schema = signInSchema(dummyT as unknown as Parameters<typeof signInSchema>[0]);

  it('gagal jika agreeTerms bernilai false', () => {
    const res = schema.safeParse({
      email: 'user@example.com',
      password: 'password123',
      agreeTerms: false,
    });
    expect(res.success).toBe(false);
  });

  it('berhasil jika email, password, dan agreeTerms valid', () => {
    const res = schema.safeParse({
      email: 'user@example.com',
      password: 'password123',
      agreeTerms: true,
    });
    expect(res.success).toBe(true);
  });
});

describe('signUpSchema with agreeTerms', () => {
  const schema = signUpSchema(dummyT as unknown as Parameters<typeof signUpSchema>[0]);

  it('gagal jika agreeTerms bernilai false', () => {
    const res = schema.safeParse({
      name: 'John Doe',
      email: 'user@example.com',
      password: 'password123',
      confirmPassword: 'password123',
      agreeTerms: false,
    });
    expect(res.success).toBe(false);
  });

  it('berhasil jika semua field valid dan agreeTerms bernilai true', () => {
    const res = schema.safeParse({
      name: 'John Doe',
      email: 'user@example.com',
      password: 'password123',
      confirmPassword: 'password123',
      agreeTerms: true,
    });
    expect(res.success).toBe(true);
  });
});

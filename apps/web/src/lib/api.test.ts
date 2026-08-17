import { describe, expect, it } from 'vitest';

import { withTimeout } from './api';

describe('withTimeout', () => {
  it('rejects when the promise never settles (black-holed host)', async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 50)).rejects.toThrow(/Timed out/);
  });

  it('passes through the value when the promise wins the race', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok');
  });
});

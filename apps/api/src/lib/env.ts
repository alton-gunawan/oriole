import { apiEnvSchema, loadRootEnv, parseEnv } from '@oriole/config';

loadRootEnv();

/** Environment API yang sudah tervalidasi. Boot gagal dengan pesan jelas jika ada yang kurang. */
export const env = parseEnv(apiEnvSchema, process.env);

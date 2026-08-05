import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';

import { queryClient } from './lib/queryClient';
import { restoreSession } from './lib/session';
import { initI18n } from './i18n';
import { router } from './router';

import './index.css';

// Pulihkan sesi (token sessionStorage → status store) sebelum render pertama.
void restoreSession();

// Muat bahasa aktif (chunk locale) sebelum render — teks siap tanpa Suspense.
async function bootstrap() {
  try {
    await initI18n();
  } catch (err) {
    // Chunk locale gagal dimuat (mis. offline) — jangan biarkan app blank;
    // i18n tetap pakai fallbackLng 'en' dan key sebagai teks.
    console.error('[i18n] Gagal menginisialisasi i18n:', err);
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Theme theme={neutralTheme}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </Theme>
    </StrictMode>,
  );
}

void bootstrap();

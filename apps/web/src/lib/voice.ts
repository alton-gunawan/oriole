/**
 * Opsi suara asisten Voice AI — ID ElevenLabs yang dikirim ke Vapi
 * (kolom workspaces.call_voice_id). Kosong = default server (env
 * VAPI_VOICE_ID). Daftar kurasi default ElevenLabs agar MVP tidak
 * menawarkan 50 konfigurasi — label tampil sebagai deskripsi suara.
 */
export const VOICE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Default (server)' },
  { value: '9BWtsMINqrJLrRacOk9x', label: 'Sarah · Female' },
  { value: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel · Female' },
  { value: 'EXAVITQu4vr4xnSDxMaL', label: 'Bella · Female' },
  { value: 'XB0fDUnXU5powFXDhCwa', label: 'Charlotte · Female' },
  { value: 'ErXwobaYiN019PkySvjV', label: 'Antoni · Male' },
  { value: 'TxGEqnHWrfWFTfGH9saT', label: 'Josh · Male' },
  { value: 'JBFqnCBsd6RMkjVDRZzb', label: 'George · Male' },
];

/** Label voice dari ID — fallback ke 'Default (server)'. */
export function voiceLabel(voiceId: string | null | undefined): string {
  const option = VOICE_OPTIONS.find((item) => item.value === voiceId);
  return option?.label ?? VOICE_OPTIONS[0].label;
}

/** Label bahasa panggilan — 'en' | 'id'. */
export function callLanguageLabel(language: string | undefined): string {
  return language === 'id' ? 'Bahasa Indonesia' : 'English';
}

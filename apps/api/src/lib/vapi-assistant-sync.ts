import { inngest } from '../inngest/client.ts';

/** Data event sinkronisasi asisten inbound (vapi/assistant.sync). */
export interface VapiAssistantSyncData {
  workspaceId: string;
  /**
   * true = buat asisten bila belum ada (opt-in: registrasi nomor inbound).
   * false = hanya update asisten yang SUDAH di-provision — workspace yang
   * belum mengaktifkan Voice AI tidak dibuatkan asisten diam-diam.
   */
  create?: boolean;
}

/**
 * Kirim event sync asisten Vapi — dipicu perubahan data bisnis (layanan /
 * KB / nama workspace) atau opt-in nomor inbound. Fungsi Inngest
 * (vapi-assistant-sync) yang memutuskan update-atau-skip; aman dipanggil
 * sering dan tidak pernah menggagalkan request pemanggil.
 */
export async function emitVapiAssistantSync(workspaceId: string, create = false): Promise<void> {
  await inngest.send({
    name: 'vapi/assistant.sync',
    data: { workspaceId, create } satisfies VapiAssistantSyncData,
  });
}

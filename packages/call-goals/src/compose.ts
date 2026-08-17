import { determineCallGoal } from './determine-call-goal.ts';
import { getGoalTemplate } from './templates.ts';
import type {
  BusinessKnowledge,
  CallGoalConfig,
  ComposeCallGoalInput,
  GoalDecision,
} from './types.ts';

/**
 * Render knowledge base → blok prompt panggilan. Label sengaja bahasa
 * Inggris (template panggilan berbahasa Inggris); isi field bebas mengikuti
 * bahasa bisnis. Kosong → string kosong (prompt tidak berubah).
 */
export function formatKnowledge(knowledge: BusinessKnowledge | null | undefined): string {
  if (!knowledge) return '';
  const lines: string[] = [];
  const push = (label: string, value?: string) => {
    if (value?.trim()) lines.push(`- ${label}: ${value.trim()}`);
  };
  push('About the business', knowledge.description);
  push('Services & prices', knowledge.services);
  push('Opening hours', knowledge.hours);
  push('Location', knowledge.location);
  push('Policy', knowledge.policy);
  for (const item of knowledge.faq ?? []) {
    if (item?.q?.trim() && item?.a?.trim()) {
      lines.push(`- Q: ${item.q.trim()} — A: ${item.a.trim()}`);
    }
  }
  return lines.join('\n');
}

/**
 * Susun konfigurasi goal final sebelum dikirim ke CALL-E.
 *
 * Aturan penggabungan:
 * - Keputusan diambil oleh `determineCallGoal` (bisa di-pass untuk hindari
 *   komputasi ganda / jika sudah dihitung lebih dulu).
 * - Override user (`customization.goalType`) menang bila bukan `'auto'`;
 *   `'auto'`/kosong = pakai hasil keputusan.
 * - `customization.customInstruction` ditambahkan sebagai paragraf tambahan
 *   pada prompt — tujuan panggilan tetap template, instruksi adalah sisipan.
 * - Kembali `null` bila keputusan menyatakan tidak perlu panggilan.
 */
export function composeCallGoal(
  input: ComposeCallGoalInput,
  decision: GoalDecision = determineCallGoal(input.booking),
): CallGoalConfig | null {
  if (decision.goalType === null) return null;

  const override = input.customization?.goalType;
  const goalType = override && override !== 'auto' ? override : decision.goalType;

  const template = getGoalTemplate(input.business.industry, goalType);
  let prompt = template.buildPrompt(input.booking, input.business);

  const customInstruction = input.customization?.customInstruction?.trim();
  if (customInstruction) {
    prompt += `\n\nExtra instruction from the business:\n${customInstruction}`;
  }

  // Knowledge base bisnis (layanan/harga/jam/lokasi/kebijakan/FAQ) —
  // asisten boleh menjawab pertanyaan dari data ini. Hanya disisipkan
  // bila ada isinya (tidak mengubah prompt untuk bisnis tanpa KB).
  const knowledgeBlock = formatKnowledge(input.business.knowledge);
  if (knowledgeBlock) {
    prompt += `\n\nBusiness information you can use to answer the customer's questions:\n${knowledgeBlock}`;
  }

  // Bahasa panggilan mengikuti setting workspace (default 'en'). Template
  // tetap membawa bahasa bawaan; business.language menang bila diisi.
  const language = input.business.language ?? template.language;

  return {
    goalType,
    title: template.title,
    summary: template.summary,
    prompt,
    resultSchema: template.resultSchema,
    tone: template.tone,
    language,
    voicemailBehavior: template.voicemailBehavior,
  };
}

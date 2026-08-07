import { determineCallGoal } from './determine-call-goal.ts';
import { getGoalTemplate } from './templates.ts';
import type { CallGoalConfig, ComposeCallGoalInput, GoalDecision } from './types.ts';

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

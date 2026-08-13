ALTER TABLE "workspaces" ADD COLUMN "chat_language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
-- Backfill: pertahankan bahasa bot yang sudah berlaku sebelum kolom ini ada
-- (saat itu bahasa chat mengikuti call_goal_language) — workspace yang sudah
-- memilih 'id' untuk panggilan tidak berubah menjadi Inggris diam-diam.
UPDATE "workspaces" SET "chat_language" = "call_goal_language" WHERE "call_goal_language" = 'id';

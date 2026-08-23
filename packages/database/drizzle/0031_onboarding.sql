ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "onboarding_completed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "onboarding_step" integer DEFAULT 1 NOT NULL;

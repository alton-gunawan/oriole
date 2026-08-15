ALTER TABLE "workspaces" ADD COLUMN "call_assistant_name" text DEFAULT 'Sarah' NOT NULL;
ALTER TABLE "workspaces" ADD COLUMN "call_voice_id" text;
ALTER TABLE "workspaces" ADD COLUMN "max_call_attempts" integer DEFAULT 2 NOT NULL;

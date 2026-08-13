CREATE TABLE "vapi_inbound_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"workspace_id" uuid NOT NULL,
	"vapi_phone_number_id" text NOT NULL,
	"number" text,
	"name" text,
	"provider" text DEFAULT 'vapi' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vapi_inbound_numbers" ADD CONSTRAINT "vapi_inbound_numbers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "neon_auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vapi_inbound_numbers" ADD CONSTRAINT "vapi_inbound_numbers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vapi_inbound_numbers_vapi_phone_number_id_idx" ON "vapi_inbound_numbers" USING btree ("vapi_phone_number_id");--> statement-breakpoint
CREATE INDEX "vapi_inbound_numbers_workspace_id_idx" ON "vapi_inbound_numbers" USING btree ("workspace_id");
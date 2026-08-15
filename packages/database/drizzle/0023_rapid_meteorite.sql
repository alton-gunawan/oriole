CREATE TYPE "public"."whatsapp_connection_status" AS ENUM('connecting', 'connected', 'error', 'disconnected');--> statement-breakpoint
CREATE TABLE "whatsapp_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"waba_id" text,
	"phone_number_id" text,
	"display_phone_number" text,
	"business_name" text,
	"status" "whatsapp_connection_status" DEFAULT 'connecting' NOT NULL,
	"error_message" text,
	"access_token_encrypted" text,
	"signup_state" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"connected_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_connections_workspace_idx" ON "whatsapp_connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "whatsapp_connections_phone_number_id_idx" ON "whatsapp_connections" USING btree ("phone_number_id");--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;

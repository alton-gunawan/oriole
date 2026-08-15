CREATE TYPE "public"."waitlist_status" AS ENUM('waiting', 'offered', 'booked', 'declined', 'expired');--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"service_id" uuid,
	"staff_id" uuid,
	"customer_name" text,
	"contact_phone" text,
	"channel_type" text DEFAULT 'telegram' NOT NULL,
	"channel_identifier" text,
	"preferred_date" text,
	"time_preference" text,
	"status" "waitlist_status" DEFAULT 'waiting' NOT NULL,
	"offered_at" timestamp with time zone,
	"offered_slot_at" timestamp with time zone,
	"offered_service_id" uuid,
	"offered_staff_id" uuid,
	"offered_duration_minutes" integer,
	"offered_timezone" text,
	"filled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "waitlist_entries_workspace_id_idx" ON "waitlist_entries" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "waitlist_entries_workspace_status_idx" ON "waitlist_entries" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "waitlist_entries_workspace_service_idx" ON "waitlist_entries" USING btree ("workspace_id","service_id");--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_staff_id_staff_members_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_offered_service_id_services_id_fk" FOREIGN KEY ("offered_service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_offered_staff_id_staff_members_id_fk" FOREIGN KEY ("offered_staff_id") REFERENCES "public"."staff_members"("id") ON DELETE set null ON UPDATE no action;

CREATE TYPE "public"."payment_link_status" AS ENUM('pending', 'paid', 'canceled');--> statement-breakpoint
CREATE TABLE "payment_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"booking_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" "payment_link_status" DEFAULT 'pending' NOT NULL,
	"paddle_transaction_id" text,
	"checkout_url" text,
	"customer_name" text,
	"customer_email" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_links_workspace_id_idx" ON "payment_links" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "payment_links_booking_id_idx" ON "payment_links" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_paddle_transaction_idx" ON "payment_links" USING btree ("paddle_transaction_id") WHERE "payment_links"."paddle_transaction_id" is not null;
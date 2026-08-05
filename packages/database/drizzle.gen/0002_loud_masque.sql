CREATE TYPE "public"."business_industry" AS ENUM('dental', 'medspa', 'hair_salon', 'medical_clinic', 'restaurant', 'wellness', 'other');--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "customer_name" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "industry" "business_industry";--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "goal_type" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "custom_instruction" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "no_show_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "change_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calle_calls" ADD COLUMN "booking_id" uuid;--> statement-breakpoint
ALTER TABLE "calle_calls" ADD COLUMN "goal_type" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "industry" "business_industry";--> statement-breakpoint
ALTER TABLE "calle_calls" ADD CONSTRAINT "calle_calls_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calle_calls_booking_id_idx" ON "calle_calls" USING btree ("booking_id");
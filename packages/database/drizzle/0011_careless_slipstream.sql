ALTER TABLE "bookings" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "source_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_source_ref_idx" ON "bookings" USING btree ("workspace_id","source","source_ref") WHERE "bookings"."source" is not null;
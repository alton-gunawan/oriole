ALTER TYPE "public"."business_industry" ADD VALUE 'fitness' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."business_industry" ADD VALUE 'professional_services' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."business_industry" ADD VALUE 'home_services' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."business_industry" ADD VALUE 'automotive' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."business_industry" ADD VALUE 'education_coaching' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."business_industry" ADD VALUE 'photography_creative' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."business_industry" ADD VALUE 'real_estate' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."business_industry" ADD VALUE 'pet_care' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."business_industry" ADD VALUE 'space_rental' BEFORE 'other';--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "call_goal_language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "auto_call_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "auto_call_lead_hours" integer DEFAULT 24 NOT NULL;
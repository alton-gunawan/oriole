-- Simplify business_industry: 16 nilai sempit → 6 kategori luas
-- (clinic, salon, fitness, spa, dental, other). Postgres tidak bisa
-- menghapus label enum di tempat → buat tipe baru, remap data lama,
-- lalu swap.

CREATE TYPE "public"."business_industry_simple" AS ENUM ('clinic', 'salon', 'fitness', 'spa', 'dental', 'other');--> statement-breakpoint

ALTER TABLE "workspaces" ALTER COLUMN "industry" TYPE "public"."business_industry_simple" USING (
  CASE "industry"
    WHEN 'dental' THEN 'dental'::"public"."business_industry_simple"
    WHEN 'medspa' THEN 'spa'::"public"."business_industry_simple"
    WHEN 'hair_salon' THEN 'salon'::"public"."business_industry_simple"
    WHEN 'medical_clinic' THEN 'clinic'::"public"."business_industry_simple"
    WHEN 'restaurant' THEN 'other'::"public"."business_industry_simple"
    WHEN 'wellness' THEN 'spa'::"public"."business_industry_simple"
    WHEN 'fitness' THEN 'fitness'::"public"."business_industry_simple"
    WHEN 'professional_services' THEN 'other'::"public"."business_industry_simple"
    WHEN 'home_services' THEN 'other'::"public"."business_industry_simple"
    WHEN 'automotive' THEN 'other'::"public"."business_industry_simple"
    WHEN 'education_coaching' THEN 'other'::"public"."business_industry_simple"
    WHEN 'photography_creative' THEN 'other'::"public"."business_industry_simple"
    WHEN 'real_estate' THEN 'other'::"public"."business_industry_simple"
    WHEN 'pet_care' THEN 'other'::"public"."business_industry_simple"
    WHEN 'space_rental' THEN 'other'::"public"."business_industry_simple"
    WHEN 'other' THEN 'other'::"public"."business_industry_simple"
  END
);--> statement-breakpoint

ALTER TABLE "bookings" ALTER COLUMN "industry" TYPE "public"."business_industry_simple" USING (
  CASE "industry"
    WHEN 'dental' THEN 'dental'::"public"."business_industry_simple"
    WHEN 'medspa' THEN 'spa'::"public"."business_industry_simple"
    WHEN 'hair_salon' THEN 'salon'::"public"."business_industry_simple"
    WHEN 'medical_clinic' THEN 'clinic'::"public"."business_industry_simple"
    WHEN 'restaurant' THEN 'other'::"public"."business_industry_simple"
    WHEN 'wellness' THEN 'spa'::"public"."business_industry_simple"
    WHEN 'fitness' THEN 'fitness'::"public"."business_industry_simple"
    WHEN 'professional_services' THEN 'other'::"public"."business_industry_simple"
    WHEN 'home_services' THEN 'other'::"public"."business_industry_simple"
    WHEN 'automotive' THEN 'other'::"public"."business_industry_simple"
    WHEN 'education_coaching' THEN 'other'::"public"."business_industry_simple"
    WHEN 'photography_creative' THEN 'other'::"public"."business_industry_simple"
    WHEN 'real_estate' THEN 'other'::"public"."business_industry_simple"
    WHEN 'pet_care' THEN 'other'::"public"."business_industry_simple"
    WHEN 'space_rental' THEN 'other'::"public"."business_industry_simple"
    WHEN 'other' THEN 'other'::"public"."business_industry_simple"
  END
);--> statement-breakpoint

DROP TYPE "public"."business_industry";--> statement-breakpoint

ALTER TYPE "public"."business_industry_simple" RENAME TO "business_industry";

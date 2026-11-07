ALTER TABLE "vireo"."samples" DROP CONSTRAINT "ck_vireo_samples_verdict";--> statement-breakpoint
ALTER TABLE "vireo"."samples" ADD COLUMN "score" smallint;--> statement-breakpoint
-- old calls get their tap score, so the call check holds
UPDATE "vireo"."samples" SET "score" = CASE "verdict" WHEN 'amazing' THEN 9 WHEN 'good' THEN 7 WHEN 'bad' THEN 2 END WHERE "verdict" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "vireo"."samples" ADD CONSTRAINT "ck_vireo_samples_score" CHECK ("vireo"."samples"."score" BETWEEN 1 AND 10);--> statement-breakpoint
ALTER TABLE "vireo"."samples" ADD CONSTRAINT "ck_vireo_samples_call" CHECK ("vireo"."samples"."verdict" IS NOT DISTINCT FROM (CASE WHEN "vireo"."samples"."score" >= 9 THEN 'amazing' WHEN "vireo"."samples"."score" >= 7 THEN 'good' WHEN "vireo"."samples"."score" >= 4 THEN 'okay' WHEN "vireo"."samples"."score" >= 1 THEN 'bad' END));--> statement-breakpoint
ALTER TABLE "vireo"."samples" ADD CONSTRAINT "ck_vireo_samples_verdict" CHECK (("verdict")::text = ANY ((ARRAY['amazing'::character varying, 'good'::character varying, 'okay'::character varying, 'bad'::character varying])::text[]));
ALTER TABLE "vireo"."batches" ADD COLUMN "n" integer;--> statement-breakpoint
-- number old batches per subject in the order they were made
UPDATE "vireo"."batches" b SET "n" = o."n" FROM (
  SELECT "id", row_number() OVER (PARTITION BY "subject_id" ORDER BY "created_at", "id") AS "n"
  FROM "vireo"."batches"
) o WHERE o."id" = b."id";--> statement-breakpoint
ALTER TABLE "vireo"."batches" ALTER COLUMN "n" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vireo"."batches" ADD CONSTRAINT "uq_vireo_batches_subject_n" UNIQUE("subject_id","n");

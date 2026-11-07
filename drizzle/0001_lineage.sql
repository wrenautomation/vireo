CREATE TABLE "vireo"."lineage" (
	"child_id" integer NOT NULL,
	"parent_id" integer NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"took" text,
	CONSTRAINT "pk_lineage" PRIMARY KEY("child_id","parent_id"),
	CONSTRAINT "ck_vireo_lineage_not_self" CHECK ("child_id" <> "parent_id")
);
--> statement-breakpoint
ALTER TABLE "vireo"."samples" ADD COLUMN "name" varchar(60);--> statement-breakpoint
ALTER TABLE "vireo"."lineage" ADD CONSTRAINT "fk_lineage_child_id_samples" FOREIGN KEY ("child_id") REFERENCES "vireo"."samples"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vireo"."lineage" ADD CONSTRAINT "fk_lineage_parent_id_samples" FOREIGN KEY ("parent_id") REFERENCES "vireo"."samples"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_vireo_lineage_parent" ON "vireo"."lineage" USING btree ("parent_id");--> statement-breakpoint
-- copy each old parent_id to one lineage row; a dangling id (parent deleted) is dropped
INSERT INTO "vireo"."lineage" ("child_id", "parent_id", "position")
SELECT c."id", c."parent_id", 0 FROM "vireo"."samples" c
JOIN "vireo"."samples" p ON p."id" = c."parent_id"
WHERE c."parent_id" IS NOT NULL AND c."parent_id" <> c."id";

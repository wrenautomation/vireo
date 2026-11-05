CREATE SCHEMA "vireo";
--> statement-breakpoint
CREATE TABLE "vireo"."batches" (
	"id" serial NOT NULL,
	"subject_id" integer NOT NULL,
	"why" text NOT NULL,
	"agent" varchar(120),
	"state" varchar(8) DEFAULT 'open' NOT NULL,
	"note" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_batches" PRIMARY KEY("id"),
	CONSTRAINT "ck_vireo_batches_state" CHECK (("state")::text = ANY ((ARRAY['open'::character varying, 'closed'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "vireo"."guides" (
	"id" serial NOT NULL,
	"text" text NOT NULL,
	"source" varchar(8) DEFAULT 'person' NOT NULL,
	"ref" text,
	"subject_id" integer,
	"kind" varchar(8),
	"state" varchar(8) DEFAULT 'testing' NOT NULL,
	"by" varchar(320),
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_guides" PRIMARY KEY("id"),
	CONSTRAINT "ck_vireo_guides_source" CHECK (("source")::text = ANY ((ARRAY['person'::character varying, 'study'::character varying, 'sop'::character varying, 'skill'::character varying, 'agent'::character varying])::text[])),
	CONSTRAINT "ck_vireo_guides_kind" CHECK (("kind")::text = ANY ((ARRAY['text'::character varying, 'image'::character varying, 'video'::character varying, 'page'::character varying])::text[])),
	CONSTRAINT "ck_vireo_guides_state" CHECK (("state")::text = ANY ((ARRAY['testing'::character varying, 'locked'::character varying, 'dropped'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "vireo"."notes" (
	"id" serial NOT NULL,
	"sample_id" integer NOT NULL,
	"anchor" jsonb,
	"tone" varchar(4),
	"text" text,
	"by" varchar(320),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_notes" PRIMARY KEY("id"),
	CONSTRAINT "ck_vireo_notes_tone" CHECK (("tone")::text = ANY ((ARRAY['good'::character varying, 'bad'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "vireo"."outcomes" (
	"ship_id" integer NOT NULL,
	"segment" varchar(160) NOT NULL,
	"day" date NOT NULL,
	"metric" varchar(32) NOT NULL,
	"value" double precision NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_outcomes" PRIMARY KEY("ship_id","segment","day","metric")
);
--> statement-breakpoint
CREATE TABLE "vireo"."samples" (
	"id" serial NOT NULL,
	"batch_id" integer NOT NULL,
	"subject_id" integer NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"body" text,
	"media" text,
	"poster" text,
	"source" jsonb,
	"parent_id" integer,
	"guides" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"change" text,
	"agent" varchar(120),
	"verdict" varchar(8),
	"kept_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_samples" PRIMARY KEY("id"),
	CONSTRAINT "ck_vireo_samples_verdict" CHECK (("verdict")::text = ANY ((ARRAY['amazing'::character varying, 'good'::character varying, 'bad'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "vireo"."ships" (
	"id" serial NOT NULL,
	"sample_id" integer NOT NULL,
	"channel" varchar(32) NOT NULL,
	"target" varchar(200) NOT NULL,
	"why" text,
	"by" varchar(320),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "pk_ships" PRIMARY KEY("id"),
	CONSTRAINT "uq_vireo_ships_target" UNIQUE("channel","target","sample_id")
);
--> statement-breakpoint
CREATE TABLE "vireo"."subjects" (
	"id" serial NOT NULL,
	"slug" varchar(60) NOT NULL,
	"name" text NOT NULL,
	"kind" varchar(8) NOT NULL,
	"brief" text,
	"seeds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" varchar(8) DEFAULT 'open' NOT NULL,
	"by" varchar(320),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_subjects" PRIMARY KEY("id"),
	CONSTRAINT "uq_vireo_subjects_slug" UNIQUE("slug"),
	CONSTRAINT "ck_vireo_subjects_kind" CHECK (("kind")::text = ANY ((ARRAY['text'::character varying, 'image'::character varying, 'video'::character varying, 'page'::character varying])::text[])),
	CONSTRAINT "ck_vireo_subjects_state" CHECK (("state")::text = ANY ((ARRAY['open'::character varying, 'paused'::character varying, 'done'::character varying])::text[]))
);
--> statement-breakpoint
ALTER TABLE "vireo"."batches" ADD CONSTRAINT "fk_batches_subject_id_subjects" FOREIGN KEY ("subject_id") REFERENCES "vireo"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vireo"."guides" ADD CONSTRAINT "fk_guides_subject_id_subjects" FOREIGN KEY ("subject_id") REFERENCES "vireo"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vireo"."notes" ADD CONSTRAINT "fk_notes_sample_id_samples" FOREIGN KEY ("sample_id") REFERENCES "vireo"."samples"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vireo"."outcomes" ADD CONSTRAINT "fk_outcomes_ship_id_ships" FOREIGN KEY ("ship_id") REFERENCES "vireo"."ships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vireo"."samples" ADD CONSTRAINT "fk_samples_batch_id_batches" FOREIGN KEY ("batch_id") REFERENCES "vireo"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vireo"."samples" ADD CONSTRAINT "fk_samples_subject_id_subjects" FOREIGN KEY ("subject_id") REFERENCES "vireo"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vireo"."ships" ADD CONSTRAINT "fk_ships_sample_id_samples" FOREIGN KEY ("sample_id") REFERENCES "vireo"."samples"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_vireo_batches_subject" ON "vireo"."batches" USING btree ("subject_id","state");--> statement-breakpoint
CREATE INDEX "ix_vireo_guides_subject" ON "vireo"."guides" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "ix_vireo_notes_sample" ON "vireo"."notes" USING btree ("sample_id");--> statement-breakpoint
CREATE INDEX "ix_vireo_samples_batch" ON "vireo"."samples" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "ix_vireo_samples_subject" ON "vireo"."samples" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "ix_vireo_ships_sample" ON "vireo"."ships" USING btree ("sample_id");
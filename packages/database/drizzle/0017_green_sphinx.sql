-- pgvector: dibutuhkan untuk kolom knowledge_chunks.embedding. Neon sudah
-- mengizinkan ekstensi ini (allowlist); database lokal perlu mengaktifkannya
-- sekali (CREATE EXTENSION vector).
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_type" AS ENUM('notion_page', 'notion_database');--> statement-breakpoint
CREATE TYPE "public"."knowledge_sync_status" AS ENUM('synced', 'failed', 'deleted');--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"token_count" integer,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"source_type" "knowledge_source_type" NOT NULL,
	"notion_page_id" text NOT NULL,
	"notion_database_id" text,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"source_url" text,
	"content_hash" text NOT NULL,
	"status" "knowledge_sync_status" DEFAULT 'synced' NOT NULL,
	"last_synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_type" "knowledge_source_type" NOT NULL,
	"notion_page_id" text,
	"notion_database_id" text,
	"title" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_status" "knowledge_sync_status",
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_sync_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_id" uuid,
	"status" text NOT NULL,
	"pages_processed" integer DEFAULT 0 NOT NULL,
	"chunks_created" integer DEFAULT 0 NOT NULL,
	"message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sync_logs" ADD CONSTRAINT "knowledge_sync_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sync_logs" ADD CONSTRAINT "knowledge_sync_logs_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_chunks_workspace_id_idx" ON "knowledge_chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_document_id_idx" ON "knowledge_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_embedding_hnsw_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_documents_page_idx" ON "knowledge_documents" USING btree ("workspace_id","notion_page_id");--> statement-breakpoint
CREATE INDEX "knowledge_documents_workspace_id_idx" ON "knowledge_documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "knowledge_documents_source_id_idx" ON "knowledge_documents" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_sources_page_idx" ON "knowledge_sources" USING btree ("workspace_id","source_type","notion_page_id") WHERE "knowledge_sources"."notion_page_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_sources_database_idx" ON "knowledge_sources" USING btree ("workspace_id","source_type","notion_database_id") WHERE "knowledge_sources"."notion_database_id" is not null;--> statement-breakpoint
CREATE INDEX "knowledge_sources_workspace_id_idx" ON "knowledge_sources" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "knowledge_sync_logs_workspace_id_idx" ON "knowledge_sync_logs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "knowledge_sync_logs_source_id_idx" ON "knowledge_sync_logs" USING btree ("source_id");
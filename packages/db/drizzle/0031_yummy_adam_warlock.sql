CREATE TABLE "storage_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"active_provider" text DEFAULT 's3' NOT NULL,
	"s3_endpoint" text,
	"s3_region" text,
	"s3_bucket" text,
	"s3_access_key_id" text,
	"s3_force_path_style" boolean,
	"s3_signed_url_ttl" integer,
	"s3_secret_access_key_enc" text,
	"folder_path" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

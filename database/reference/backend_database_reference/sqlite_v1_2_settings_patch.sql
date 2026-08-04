-- SQLite compatibility patch v1.2.0
-- Adds the business-day settings required by the final PRD.
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
ALTER TABLE app_settings ADD COLUMN timezone_name TEXT NOT NULL DEFAULT 'Asia/Hebron';
ALTER TABLE app_settings ADD COLUMN business_day_start_minutes INTEGER NOT NULL DEFAULT 720
    CHECK (business_day_start_minutes BETWEEN 0 AND 1439);
ALTER TABLE app_settings ADD COLUMN business_day_end_minutes INTEGER NOT NULL DEFAULT 720
    CHECK (business_day_end_minutes BETWEEN 0 AND 1439);
ALTER TABLE app_settings ADD COLUMN business_day_mode TEXT NOT NULL DEFAULT 'fixed_24h'
    CHECK (business_day_mode IN ('fixed_24h','custom'));
PRAGMA user_version = 10200;
COMMIT;

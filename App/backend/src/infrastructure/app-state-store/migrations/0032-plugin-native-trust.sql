-- Incremental extension of the baseline 0026 plugin table. Existing releases
-- remain sandboxed until a trusted registry supplies a new verified release.
ALTER TABLE installed_plugins ADD COLUMN native_execution_allowed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE installed_plugins ADD COLUMN registry_origin TEXT;

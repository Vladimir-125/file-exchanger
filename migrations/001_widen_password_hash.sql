-- For databases created before the scrypt migration: scrypt hashes are ~170
-- characters, longer than the old sha256 hex columns. Safe to run more than once.
ALTER TABLE files         MODIFY password_hash VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE users         MODIFY password_hash VARCHAR(255) NOT NULL;
ALTER TABLE users         MODIFY salt          VARCHAR(64)  NOT NULL DEFAULT '';
ALTER TABLE not_confirmed MODIFY password_hash VARCHAR(255) NOT NULL;
ALTER TABLE not_confirmed MODIFY salt          VARCHAR(64)  NOT NULL DEFAULT '';
ALTER TABLE not_confirmed MODIFY confirm_url   VARCHAR(128) NOT NULL;

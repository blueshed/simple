CREATE TABLE "user" (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
);

-- Refresh tokens for token rotation (framework-managed)
CREATE TABLE _refresh_token (
    id          SERIAL PRIMARY KEY,
    user_id     INT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    token       TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ DEFAULT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_token_active ON _refresh_token (token) WHERE revoked_at IS NULL;
CREATE INDEX idx_refresh_token_user   ON _refresh_token (user_id) WHERE revoked_at IS NULL;

-- Add your domain tables below.
-- Example:
-- CREATE TABLE thing (
--     id      SERIAL PRIMARY KEY,
--     user_id INT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
--     name    TEXT NOT NULL
-- );

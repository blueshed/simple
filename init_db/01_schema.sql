CREATE TABLE "user" (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
);

-- Add your domain tables below.
-- Example:
-- CREATE TABLE thing (
--     id      SERIAL PRIMARY KEY,
--     user_id INT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
--     name    TEXT NOT NULL
-- );

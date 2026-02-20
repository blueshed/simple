CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER DATABASE "myapp" SET app.token_secret = 'change-me-in-production';

-- _make_token(user_id) -> text
-- Encrypts user_id into an opaque token using pgp_sym_encrypt

CREATE OR REPLACE FUNCTION _make_token(p_user_id INT)
RETURNS TEXT LANGUAGE sql AS $$
    SELECT replace(
        encode(pgp_sym_encrypt(p_user_id::text, current_setting('app.token_secret')), 'base64'),
        E'\n', ''
    );
$$;

-- _verify_token(token) -> int
-- Decrypts token back to user_id, raises on invalid token

CREATE OR REPLACE FUNCTION _verify_token(p_token TEXT)
RETURNS INT LANGUAGE plpgsql AS $$
BEGIN
    RETURN pgp_sym_decrypt(decode(p_token, 'base64'), current_setting('app.token_secret'))::int;
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'invalid token';
END;
$$;

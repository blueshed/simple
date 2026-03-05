CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER DATABASE "myapp" SET app.token_secret = 'change-me-in-production';
ALTER DATABASE "myapp" SET app.access_token_ttl = '3600';     -- 1 hour
ALTER DATABASE "myapp" SET app.refresh_token_ttl = '604800';  -- 7 days

-- _make_token(user_id) -> text
-- Encrypts user_id:expires_epoch into an opaque token using pgp_sym_encrypt

CREATE OR REPLACE FUNCTION _make_token(p_user_id INT)
RETURNS TEXT LANGUAGE sql AS $$
    SELECT replace(
        encode(
            pgp_sym_encrypt(
                p_user_id::text || ':' || (extract(epoch FROM now()) + current_setting('app.access_token_ttl')::int)::bigint::text,
                current_setting('app.token_secret')
            ),
            'base64'
        ),
        E'\n', ''
    );
$$;

-- _verify_token(token) -> int
-- Decrypts token, checks expiry, returns user_id.
-- Raises 'token expired' (distinct from 'invalid token') when past TTL.
-- Backward compatible: legacy tokens without ':' are accepted without expiry check.

CREATE OR REPLACE FUNCTION _verify_token(p_token TEXT)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
    v_payload TEXT;
    v_parts TEXT[];
BEGIN
    v_payload := pgp_sym_decrypt(decode(p_token, 'base64'), current_setting('app.token_secret'));
    v_parts := string_to_array(v_payload, ':');
    IF array_length(v_parts, 1) < 2 THEN
        -- Legacy token (just user_id, no expiry)
        RETURN v_payload::int;
    END IF;
    IF extract(epoch FROM now()) > v_parts[2]::bigint THEN
        RAISE EXCEPTION 'token expired';
    END IF;
    RETURN v_parts[1]::int;
EXCEPTION
    WHEN OTHERS THEN
        IF SQLERRM = 'token expired' THEN
            RAISE;
        END IF;
        RAISE EXCEPTION 'invalid token';
END;
$$;

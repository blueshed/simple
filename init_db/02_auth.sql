-- profile_doc(user_id) -> jsonb
-- Called on WebSocket open; becomes the client's profile signal.
-- Extend with whatever the client needs at startup.

CREATE OR REPLACE FUNCTION profile_doc(p_user_id INT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'profile', jsonb_build_object(
            'id',    u.id,
            'name',  u.name,
            'email', u.email
        )
    ) INTO v_result
    FROM "user" u
    WHERE u.id = p_user_id;

    IF v_result IS NULL THEN
        RAISE EXCEPTION 'user % not found', p_user_id;
    END IF;

    RETURN v_result;
END;
$$;

-- _make_refresh_token(user_id) -> text
-- Creates a random refresh token, stores it in _refresh_token table.

CREATE OR REPLACE FUNCTION _make_refresh_token(p_user_id INT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
    v_token TEXT;
BEGIN
    v_token := encode(gen_random_bytes(32), 'hex');
    INSERT INTO _refresh_token (user_id, token, expires_at)
    VALUES (
        p_user_id,
        v_token,
        now() + (current_setting('app.refresh_token_ttl')::int || ' seconds')::interval
    );
    RETURN v_token;
END;
$$;

-- _token_response(user_id) -> jsonb
-- Builds the token + refreshToken + expiresIn fields shared by login/register/refresh.

CREATE OR REPLACE FUNCTION _token_response(p_user_id INT)
RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object(
        'token',        _make_token(p_user_id),
        'refreshToken', _make_refresh_token(p_user_id),
        'expiresIn',    current_setting('app.access_token_ttl')::int
    );
$$;

-- register(name, email, password) -> jsonb (token + refreshToken + expiresIn + profile)

CREATE OR REPLACE FUNCTION register(p_name TEXT, p_email TEXT, p_password TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_user_id INT;
BEGIN
    INSERT INTO "user" (name, email, password_hash)
    VALUES (p_name, p_email, crypt(p_password, gen_salt('bf')))
    RETURNING id INTO v_user_id;

    RETURN _token_response(v_user_id) || profile_doc(v_user_id);
END;
$$;

-- login(email, password) -> jsonb (token + refreshToken + expiresIn + profile)

CREATE OR REPLACE FUNCTION login(p_email TEXT, p_password TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_user_id INT;
BEGIN
    SELECT u.id INTO v_user_id
      FROM "user" u
     WHERE u.email = p_email
       AND u.password_hash = crypt(p_password, u.password_hash);

    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'invalid email or password';
    END IF;

    RETURN _token_response(v_user_id) || profile_doc(v_user_id);
END;
$$;

-- refresh_token(refresh_token_string) -> jsonb (new token pair)
-- Pre-auth: no user_id parameter. Validates and rotates the refresh token.

CREATE OR REPLACE FUNCTION refresh_token(p_refresh_token TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_row _refresh_token%ROWTYPE;
BEGIN
    -- Atomically find and revoke the refresh token
    UPDATE _refresh_token
       SET revoked_at = now()
     WHERE token = p_refresh_token
       AND revoked_at IS NULL
       AND expires_at > now()
    RETURNING * INTO v_row;

    IF v_row IS NULL THEN
        RAISE EXCEPTION 'invalid or expired refresh token';
    END IF;

    RETURN _token_response(v_row.user_id);
END;
$$;

-- revoke_refresh_tokens(user_id) -> void
-- Authed: called over WebSocket on logout. Revokes all active refresh tokens.

CREATE OR REPLACE FUNCTION revoke_refresh_tokens(p_user_id INT)
RETURNS JSONB LANGUAGE sql AS $$
    UPDATE _refresh_token
       SET revoked_at = now()
     WHERE user_id = p_user_id
       AND revoked_at IS NULL;
    SELECT '{}'::jsonb;
$$;

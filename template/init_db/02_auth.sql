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

-- register(name, email, password) -> jsonb (token + profile)

CREATE OR REPLACE FUNCTION register(p_name TEXT, p_email TEXT, p_password TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_user_id INT;
BEGIN
    INSERT INTO "user" (name, email, password_hash)
    VALUES (p_name, p_email, crypt(p_password, gen_salt('bf')))
    RETURNING id INTO v_user_id;

    RETURN jsonb_build_object('token', _make_token(v_user_id)) || profile_doc(v_user_id);
END;
$$;

-- login(email, password) -> jsonb (token + profile)

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

    RETURN jsonb_build_object('token', _make_token(v_user_id)) || profile_doc(v_user_id);
END;
$$;

-- Test domain: thing with nested items
-- Used by WebSocket protocol and notification fan-out tests

CREATE TABLE thing (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    owner_id   INT NOT NULL REFERENCES "user"(id),
    version    INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE item (
    id        SERIAL PRIMARY KEY,
    thing_id  INT NOT NULL REFERENCES thing(id) ON DELETE CASCADE,
    title     TEXT NOT NULL
);

-- Collection doc: list of things owned by user
CREATE OR REPLACE FUNCTION thing_list(p_user_id INT)
RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    RETURN jsonb_build_object(
        'thing_list', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) ORDER BY t.id)
            FROM thing t WHERE t.owner_id = p_user_id
        ), '[]'::jsonb)
    );
END;
$$;

-- Entity doc: single thing with nested items
CREATE OR REPLACE FUNCTION thing_doc(p_user_id INT, p_thing_id INT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_result JSONB;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM thing WHERE id = p_thing_id AND owner_id = p_user_id) THEN
        RAISE EXCEPTION 'permission denied';
    END IF;

    SELECT jsonb_build_object(
        'thing', jsonb_build_object(
            'id',      t.id,
            'name',    t.name,
            'version', t.version,
            'items',   COALESCE((
                SELECT jsonb_agg(jsonb_build_object('id', i.id, 'title', i.title) ORDER BY i.id)
                FROM item i WHERE i.thing_id = t.id
            ), '[]'::jsonb)
        )
    ) INTO v_result
    FROM thing t WHERE t.id = p_thing_id;

    RETURN v_result;
END;
$$;

-- Save thing (upsert + notify)
CREATE OR REPLACE FUNCTION save_thing(
    p_user_id INT,
    p_id INT DEFAULT NULL,
    p_name TEXT DEFAULT NULL,
    p_version INT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_row thing%ROWTYPE;
BEGIN
    IF p_id IS NULL THEN
        INSERT INTO thing (name, owner_id)
        VALUES (p_name, p_user_id)
        RETURNING * INTO v_row;
    ELSE
        IF NOT EXISTS (SELECT 1 FROM thing WHERE id = p_id AND owner_id = p_user_id) THEN
            RAISE EXCEPTION 'permission denied';
        END IF;
        UPDATE thing SET
            name = COALESCE(p_name, name),
            version = version + 1
        WHERE id = p_id AND (p_version IS NULL OR version = p_version)
        RETURNING * INTO v_row;

        IF v_row IS NULL THEN
            RAISE EXCEPTION 'version conflict';
        END IF;
    END IF;

    -- Notify: upsert in thing_list collection, and root update in thing_doc
    PERFORM pg_notify('change', jsonb_build_object(
        'fn',   'save_thing',
        'op',   'upsert',
        'data', row_to_json(v_row)::jsonb,
        'targets', jsonb_build_array(
            jsonb_build_object('doc', 'thing_list', 'collection', 'thing_list', 'doc_id', 0),
            jsonb_build_object('doc', 'thing_doc',  'collection', NULL,          'doc_id', v_row.id)
        )
    )::text);

    RETURN row_to_json(v_row)::jsonb;
END;
$$;

-- Remove thing + notify
CREATE OR REPLACE FUNCTION remove_thing(p_user_id INT, p_thing_id INT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_row thing%ROWTYPE;
BEGIN
    DELETE FROM thing WHERE id = p_thing_id AND owner_id = p_user_id
    RETURNING * INTO v_row;
    IF v_row IS NULL THEN
        RAISE EXCEPTION 'not found or permission denied';
    END IF;

    PERFORM pg_notify('change', jsonb_build_object(
        'fn',   'remove_thing',
        'op',   'remove',
        'data', jsonb_build_object('id', v_row.id),
        'targets', jsonb_build_array(
            jsonb_build_object('doc', 'thing_list', 'collection', 'thing_list', 'doc_id', 0),
            jsonb_build_object('doc', 'thing_doc',  'collection', NULL,          'doc_id', v_row.id)
        )
    )::text);

    RETURN jsonb_build_object('id', v_row.id);
END;
$$;

-- Save item (nested collection upsert + notify)
CREATE OR REPLACE FUNCTION save_item(
    p_user_id INT,
    p_id INT DEFAULT NULL,
    p_thing_id INT DEFAULT NULL,
    p_title TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_row item%ROWTYPE;
    v_thing_id INT;
BEGIN
    IF p_id IS NULL THEN
        -- Insert: verify ownership of parent thing
        IF NOT EXISTS (SELECT 1 FROM thing WHERE id = p_thing_id AND owner_id = p_user_id) THEN
            RAISE EXCEPTION 'permission denied';
        END IF;
        INSERT INTO item (thing_id, title) VALUES (p_thing_id, p_title)
        RETURNING * INTO v_row;
        v_thing_id := p_thing_id;
    ELSE
        -- Update: resolve thing_id from existing item
        SELECT i.thing_id INTO v_thing_id FROM item i
        JOIN thing t ON t.id = i.thing_id
        WHERE i.id = p_id AND t.owner_id = p_user_id;
        IF v_thing_id IS NULL THEN
            RAISE EXCEPTION 'permission denied';
        END IF;
        UPDATE item SET title = COALESCE(p_title, title) WHERE id = p_id
        RETURNING * INTO v_row;
    END IF;

    PERFORM pg_notify('change', jsonb_build_object(
        'fn',   'save_item',
        'op',   'upsert',
        'data', row_to_json(v_row)::jsonb,
        'targets', jsonb_build_array(
            jsonb_build_object(
                'doc',        'thing_doc',
                'collection', 'thing.items',
                'doc_id',     v_thing_id,
                'parent_ids', jsonb_build_array()
            )
        )
    )::text);

    RETURN row_to_json(v_row)::jsonb;
END;
$$;

-- Remove item + notify
CREATE OR REPLACE FUNCTION remove_item(p_user_id INT, p_item_id INT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_row item%ROWTYPE;
    v_thing_id INT;
BEGIN
    SELECT i.thing_id INTO v_thing_id FROM item i
    JOIN thing t ON t.id = i.thing_id
    WHERE i.id = p_item_id AND t.owner_id = p_user_id;
    IF v_thing_id IS NULL THEN
        RAISE EXCEPTION 'not found or permission denied';
    END IF;

    DELETE FROM item WHERE id = p_item_id RETURNING * INTO v_row;

    PERFORM pg_notify('change', jsonb_build_object(
        'fn',   'remove_item',
        'op',   'remove',
        'data', jsonb_build_object('id', v_row.id),
        'targets', jsonb_build_array(
            jsonb_build_object(
                'doc',        'thing_doc',
                'collection', 'thing.items',
                'doc_id',     v_thing_id,
                'parent_ids', jsonb_build_array()
            )
        )
    )::text);

    RETURN jsonb_build_object('id', v_row.id);
END;
$$;

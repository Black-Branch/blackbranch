-- Fresh-install BASELINE — the schema a full replay of migrations/schema.sql + every
-- migration up to v164 leaves, with NO data.
--
-- 🔴 GENERATED. Never edit by hand: run `node tools/check-baseline.mjs --generate`.
-- CI fails until this file matches the chain,
-- so every new migration lands together with a regenerated baseline.
--
-- Applied ONCE, to an EMPTY database, followed by baseline/seed.sql and then every migration
-- newer than v164. It is not re-runnable on purpose: a database that already holds a
-- schema must take migrations, never a second baseline. See migrations/baseline/README.md.

--
-- PostgreSQL database dump
--

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: site; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA site;

--
-- Name: stream; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA stream;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';

--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version integer NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    note text
);

--
-- Name: TABLE schema_migrations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.schema_migrations IS 'Which migrate-vN.sql have been applied. An install that started from the baseline holds one row per version up to it (note ''baseline''); applied_at is when the row was written, which for back-filled and baseline rows is not when the migration first ran.';

--
-- Name: account_deletions; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.account_deletions (
    matrix_id text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    site_erased_at timestamp with time zone,
    memory_erased_at timestamp with time zone,
    matrix_erased_at timestamp with time zone,
    matrix_error text
);

--
-- Name: accounts; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.accounts (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    matrix_id text NOT NULL,
    type text NOT NULL,
    provider text NOT NULL,
    provider_account_id text NOT NULL,
    refresh_token text,
    access_token text,
    expires_at bigint,
    token_type text,
    scope text,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    account_display_name text,
    refresh_failed_at timestamp with time zone
);

--
-- Name: COLUMN accounts.refresh_failed_at; Type: COMMENT; Schema: site; Owner: -
--

COMMENT ON COLUMN site.accounts.refresh_failed_at IS 'When the platform refused this link''s refresh token (HTTP 400/401). NULL = the link works. Cleared by linking again or by a successful refresh.';

--
-- Name: ai_slots; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.ai_slots (
    slot_id text NOT NULL,
    package text NOT NULL,
    owner text NOT NULL,
    kind text NOT NULL,
    needs text[] DEFAULT '{}'::text[] NOT NULL,
    label text NOT NULL,
    description text NOT NULL,
    provides_bot text,
    last_reported_at timestamp with time zone NOT NULL
);

--
-- Name: ai_usage; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.ai_usage (
    day date NOT NULL,
    slot_id text NOT NULL,
    connection_id text NOT NULL,
    model text NOT NULL,
    calls integer DEFAULT 0 NOT NULL,
    errors integer DEFAULT 0 NOT NULL,
    unchecked integer DEFAULT 0 NOT NULL,
    tokens_in bigint DEFAULT 0 NOT NULL,
    tokens_out bigint DEFAULT 0 NOT NULL
);

--
-- Name: atproto_oauth_state; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.atproto_oauth_state (
    key text NOT NULL,
    state jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: atproto_sessions; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.atproto_sessions (
    did text NOT NULL,
    session jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: automod_held; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.automod_held (
    id bigint NOT NULL,
    twitch_msg_id text,
    user_id text,
    user_login text,
    user_name text,
    text text NOT NULL,
    category text,
    level integer,
    status text DEFAULT 'pending'::text NOT NULL,
    held_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_by text,
    resolved_at timestamp with time zone,
    source text DEFAULT 'twitch'::text NOT NULL,
    platform text,
    matrix_id text,
    matched_term text,
    site_msg_id bigint,
    confidence numeric(3,2),
    CONSTRAINT automod_held_source_check CHECK ((source = ANY (ARRAY['twitch'::text, 'blocklist'::text, 'account_age'::text, 'link_gate'::text, 'ai'::text]))),
    CONSTRAINT automod_held_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'allowed'::text, 'denied'::text, 'expired'::text, 'external'::text, 'blocked'::text, 'flagged'::text])))
);

--
-- Name: automod_held_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

CREATE SEQUENCE site.automod_held_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: automod_held_id_seq; Type: SEQUENCE OWNED BY; Schema: site; Owner: -
--

ALTER SEQUENCE site.automod_held_id_seq OWNED BY site.automod_held.id;

--
-- Name: badge_slots; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.badge_slots (
    matrix_id text NOT NULL,
    base_slots integer DEFAULT 0 NOT NULL,
    equipped bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: badge_unlocks; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.badge_unlocks (
    matrix_id text NOT NULL,
    badge_id bigint NOT NULL
);

--
-- Name: badges; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.badges (
    id bigint NOT NULL,
    name text NOT NULL,
    image_url text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_subscriber boolean DEFAULT false NOT NULL,
    is_mod boolean DEFAULT false NOT NULL,
    unlock_criteria jsonb
);

--
-- Name: badges_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

CREATE SEQUENCE site.badges_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: badges_id_seq; Type: SEQUENCE OWNED BY; Schema: site; Owner: -
--

ALTER SEQUENCE site.badges_id_seq OWNED BY site.badges.id;

--
-- Name: bans; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.bans (
    matrix_id text NOT NULL,
    banned_by text NOT NULL,
    reason text,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: blocklist_overrides; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.blocklist_overrides (
    term text NOT NULL,
    severity smallint NOT NULL,
    set_by text NOT NULL,
    set_at timestamp with time zone DEFAULT now() NOT NULL,
    note text,
    kind text DEFAULT 'word'::text NOT NULL,
    CONSTRAINT blocklist_overrides_kind_check CHECK ((kind = ANY (ARRAY['word'::text, 'host'::text]))),
    CONSTRAINT blocklist_overrides_severity_check CHECK (((severity >= 1) AND (severity <= 3)))
);

--
-- Name: chat_message_platform_copies; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.chat_message_platform_copies (
    site_msg_id bigint NOT NULL,
    platform text NOT NULL,
    platform_msg_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: chat_messages; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.chat_messages (
    id bigint NOT NULL,
    matrix_id text,
    message text NOT NULL,
    is_deleted boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reply_to_id bigint,
    reply_to_username text,
    reply_to_text text,
    dest_platform text,
    event_kind text,
    event_json jsonb,
    dest_platforms text,
    encrypted_text text,
    emotes jsonb
);

--
-- Name: chat_messages_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

CREATE SEQUENCE site.chat_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: chat_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: site; Owner: -
--

ALTER SEQUENCE site.chat_messages_id_seq OWNED BY site.chat_messages.id;

--
-- Name: chat_settings; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.chat_settings (
    id integer NOT NULL,
    slow_mode_seconds integer DEFAULT 0 NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chat_settings_id_check CHECK ((id = 1)),
    CONSTRAINT chat_settings_slow_mode_seconds_check CHECK ((slow_mode_seconds >= 0))
);

--
-- Name: client_errors; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.client_errors (
    fingerprint text NOT NULL,
    source text NOT NULL,
    message text NOT NULL,
    stack text,
    page_url text,
    user_agent text,
    matrix_id text,
    occurrences integer DEFAULT 1 NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: TABLE client_errors; Type: COMMENT; Schema: site; Owner: -
--

COMMENT ON TABLE site.client_errors IS 'Deduped browser-side errors, one row per distinct fingerprint. Written by POST /api/client-error (unauthenticated, IP rate-limited, opportunistically pruned at 30 days). Read it when a user reports something vague: SELECT last_seen, occurrences, source, message FROM site.client_errors ORDER BY last_seen DESC LIMIT 20;';

--
-- Name: coin_earn_stream; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.coin_earn_stream (
    matrix_id text NOT NULL,
    stream_id bigint NOT NULL,
    watch_seconds integer DEFAULT 0 NOT NULL,
    last_beat timestamp with time zone,
    first_awarded boolean DEFAULT false NOT NULL,
    last_award_at timestamp with time zone,
    votes_awarded integer DEFAULT 0 NOT NULL,
    watch_points integer DEFAULT 0 NOT NULL,
    CONSTRAINT coin_earn_stream_votes_awarded_check CHECK ((votes_awarded >= 0)),
    CONSTRAINT coin_earn_stream_watch_points_check CHECK ((watch_points >= 0)),
    CONSTRAINT coin_earn_stream_watch_seconds_check CHECK ((watch_seconds >= 0))
);

--
-- Name: coin_earn_upvotes; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.coin_earn_upvotes (
    recipient text NOT NULL,
    voter text NOT NULL,
    stream_id bigint NOT NULL,
    paid integer DEFAULT 0 NOT NULL,
    CONSTRAINT coin_earn_upvotes_paid_check CHECK ((paid >= 0))
);

--
-- Name: coin_ledger; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.coin_ledger (
    id bigint NOT NULL,
    matrix_id text NOT NULL,
    delta bigint NOT NULL,
    kind text NOT NULL,
    sink text,
    ref text,
    meta jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: coin_ledger_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

CREATE SEQUENCE site.coin_ledger_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: coin_ledger_id_seq; Type: SEQUENCE OWNED BY; Schema: site; Owner: -
--

ALTER SEQUENCE site.coin_ledger_id_seq OWNED BY site.coin_ledger.id;

--
-- Name: coin_wallets; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.coin_wallets (
    matrix_id text NOT NULL,
    balance bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: community_embeds; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.community_embeds (
    id bigint NOT NULL,
    channel_name text NOT NULL,
    platform text NOT NULL,
    channel_url text NOT NULL,
    added_by text,
    is_live boolean DEFAULT false NOT NULL,
    priority integer DEFAULT 99 NOT NULL,
    display_name text,
    youtube_channel_id text,
    stream_title text,
    viewer_count integer,
    twitch_login text,
    ingest_enabled boolean DEFAULT true NOT NULL,
    ingest_twitch boolean DEFAULT true NOT NULL,
    ingest_youtube boolean DEFAULT true NOT NULL
);

--
-- Name: community_embeds_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

CREATE SEQUENCE site.community_embeds_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: community_embeds_id_seq; Type: SEQUENCE OWNED BY; Schema: site; Owner: -
--

ALTER SEQUENCE site.community_embeds_id_seq OWNED BY site.community_embeds.id;

--
-- Name: community_loop_videos; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.community_loop_videos (
    id integer NOT NULL,
    video_id text NOT NULL,
    title text,
    priority integer DEFAULT 0 NOT NULL,
    added_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: community_loop_videos_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

CREATE SEQUENCE site.community_loop_videos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: community_loop_videos_id_seq; Type: SEQUENCE OWNED BY; Schema: site; Owner: -
--

ALTER SEQUENCE site.community_loop_videos_id_seq OWNED BY site.community_loop_videos.id;

--
-- Name: device_health; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.device_health (
    session_id uuid NOT NULL,
    seq integer NOT NULL,
    first_at timestamp with time zone DEFAULT now() NOT NULL,
    last_at timestamp with time zone DEFAULT now() NOT NULL,
    build_id text,
    matrix_id text,
    route text NOT NULL,
    device_class text NOT NULL,
    narrow boolean,
    user_agent text,
    device_memory real,
    hw_concurrency smallint,
    effective_type text,
    save_data boolean,
    dpr real,
    open_ms bigint DEFAULT 0 NOT NULL,
    visible_ms bigint DEFAULT 0 NOT NULL,
    loaf_count integer DEFAULT 0 NOT NULL,
    loaf_blocking_ms integer DEFAULT 0 NOT NULL,
    loaf_worst jsonb,
    inp_ms integer,
    inp jsonb,
    cls real,
    req_count integer DEFAULT 0 NOT NULL,
    bytes jsonb DEFAULT '{}'::jsonb NOT NULL,
    socket_reconnects integer DEFAULT 0 NOT NULL,
    player jsonb,
    decode jsonb,
    frames jsonb,
    anim jsonb,
    settings jsonb,
    heap_start_mb real,
    heap_peak_mb real
);

--
-- Name: donations; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.donations (
    id bigint NOT NULL,
    stripe_session_id text,
    stripe_payment_intent text,
    matrix_id text,
    display_name text,
    message text,
    amount_cents integer NOT NULL,
    currency text DEFAULT 'usd'::text NOT NULL,
    status text DEFAULT 'completed'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    anonymous boolean DEFAULT false NOT NULL,
    refunded_at timestamp with time zone,
    provider text DEFAULT 'stripe'::text NOT NULL,
    external_id text,
    provider_ref text
);

--
-- Name: donations_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

ALTER TABLE site.donations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME site.donations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: federated_pending; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.federated_pending (
    token text NOT NULL,
    matrix_id text NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:02:00'::interval) NOT NULL,
    session_id uuid
);

--
-- Name: forum_pins; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.forum_pins (
    room_id text NOT NULL,
    event_id text NOT NULL,
    pinned_by text NOT NULL,
    pinned_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: forum_votes; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.forum_votes (
    room_id text NOT NULL,
    event_id text NOT NULL,
    voter_matrix_id text NOT NULL,
    author_matrix_id text NOT NULL,
    vote smallint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT forum_votes_vote_check CHECK ((vote = ANY (ARRAY['-1'::integer, 1])))
);

--
-- Name: gift_pending; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.gift_pending (
    id bigint NOT NULL,
    stripe_session_id text NOT NULL,
    gifter_matrix_id text,
    months integer NOT NULL,
    claimed_by text,
    claimed_at timestamp with time zone,
    claim_expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    anonymous boolean DEFAULT false NOT NULL
);

--
-- Name: gift_pending_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

ALTER TABLE site.gift_pending ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME site.gift_pending_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: gift_subscriptions; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.gift_subscriptions (
    id bigint NOT NULL,
    stripe_session_id text NOT NULL,
    gifter_matrix_id text,
    recipient_matrix_id text NOT NULL,
    tier text DEFAULT 'supporter'::text NOT NULL,
    months integer NOT NULL,
    kind text DEFAULT 'direct'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    anonymous boolean DEFAULT false NOT NULL
);

--
-- Name: gift_subscriptions_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

ALTER TABLE site.gift_subscriptions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME site.gift_subscriptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: house_looks; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.house_looks (
    slot smallint NOT NULL,
    name text,
    settings jsonb NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT house_looks_slot_check CHECK (((slot >= 1) AND (slot <= 4)))
);

--
-- Name: instance_config; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.instance_config (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: instance_content; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.instance_content (
    key text NOT NULL,
    body text NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: instance_history; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.instance_history (
    id bigint NOT NULL,
    key text NOT NULL,
    tier text NOT NULL,
    action text NOT NULL,
    old_value jsonb,
    new_value jsonb,
    last4 text,
    updated_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: instance_history_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

CREATE SEQUENCE site.instance_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: instance_history_id_seq; Type: SEQUENCE OWNED BY; Schema: site; Owner: -
--

ALTER SEQUENCE site.instance_history_id_seq OWNED BY site.instance_history.id;

--
-- Name: instance_secret_tests; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.instance_secret_tests (
    key text NOT NULL,
    package text NOT NULL,
    tested_at timestamp with time zone DEFAULT now() NOT NULL,
    ok boolean NOT NULL,
    detail text,
    source text,
    last4 text
);

--
-- Name: instance_secrets; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.instance_secrets (
    key text NOT NULL,
    ciphertext text NOT NULL,
    last4 text NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: lockdown; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.lockdown (
    id integer NOT NULL,
    signups_disabled boolean DEFAULT false NOT NULL,
    reason text,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    crosspost_disabled boolean DEFAULT false NOT NULL,
    min_account_age_days integer DEFAULT 0 NOT NULL,
    link_gate text DEFAULT 'off'::text NOT NULL,
    ingest_paused text[] DEFAULT '{}'::text[] NOT NULL,
    sub_only boolean DEFAULT false NOT NULL,
    expires_at timestamp with time zone,
    until_stream text,
    signups_disabled_at timestamp with time zone,
    CONSTRAINT lockdown_id_check CHECK ((id = 1)),
    CONSTRAINT lockdown_link_gate_check CHECK ((link_gate = ANY (ARRAY['off'::text, 'flag'::text, 'hold'::text])))
);

--
-- Name: sessions; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.sessions (
    stream_id text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    avg_message_words double precision,
    yt_video_id text
);

--
-- Name: lockdown_now; Type: VIEW; Schema: site; Owner: -
--

CREATE VIEW site.lockdown_now AS
 SELECT l.id,
    (l.signups_disabled AND (NOT x.expired)) AS signups_disabled,
    (l.crosspost_disabled AND (NOT x.expired)) AS crosspost_disabled,
        CASE
            WHEN x.expired THEN 0
            ELSE l.min_account_age_days
        END AS min_account_age_days,
        CASE
            WHEN x.expired THEN '{}'::text[]
            ELSE l.ingest_paused
        END AS ingest_paused,
    (l.sub_only AND (NOT x.expired)) AS sub_only,
    l.expires_at,
    x.expired,
    l.link_gate,
    l.reason,
    l.updated_by,
    l.updated_at,
    l.until_stream
   FROM (site.lockdown l
     CROSS JOIN LATERAL ( SELECT (((l.expires_at IS NOT NULL) AND (l.expires_at <= now())) OR ((l.until_stream IS NOT NULL) AND (NOT (EXISTS ( SELECT 1
                   FROM stream.sessions s
                  WHERE ((s.stream_id = l.until_stream) AND (s.ended_at IS NULL))))))) AS expired) x);

--
-- Name: memory_opt_outs; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.memory_opt_outs (
    matrix_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: message_votes; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.message_votes (
    platform text NOT NULL,
    message_id bigint NOT NULL,
    voter_matrix_id text NOT NULL,
    vote smallint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_votes_vote_check CHECK ((vote = ANY (ARRAY['-1'::integer, 1])))
);

--
-- Name: mod_log; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.mod_log (
    id bigint NOT NULL,
    action text NOT NULL,
    target_id text NOT NULL,
    performed_by text NOT NULL,
    duration_minutes integer,
    expires_at timestamp with time zone,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    batch_id uuid
);

--
-- Name: mod_log_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

CREATE SEQUENCE site.mod_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: mod_log_id_seq; Type: SEQUENCE OWNED BY; Schema: site; Owner: -
--

ALTER SEQUENCE site.mod_log_id_seq OWNED BY site.mod_log.id;

--
-- Name: payment_events; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.payment_events (
    id bigint NOT NULL,
    provider text DEFAULT 'stripe'::text NOT NULL,
    event_id text NOT NULL,
    event_type text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    session_id text,
    payment_intent_id text,
    charge_id text,
    subscription_id text,
    matrix_id text,
    kind text,
    amount_cents integer,
    currency text,
    outcome text NOT NULL,
    reason_code text,
    decline_code text,
    reason_text text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: payment_events_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

ALTER TABLE site.payment_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME site.payment_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: payment_reversals; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.payment_reversals (
    ref text NOT NULL,
    payment_key text,
    payment_id text,
    cents bigint,
    reason text,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_reversals_cents_check CHECK ((cents > 0)),
    CONSTRAINT payment_reversals_opened_has_payment CHECK (((status = 'cancelled'::text) OR ((payment_key IS NOT NULL) AND (payment_id IS NOT NULL) AND (cents IS NOT NULL) AND (reason IS NOT NULL)))),
    CONSTRAINT payment_reversals_payment_key_check CHECK ((payment_key = ANY (ARRAY['payment_intent'::text, 'capture_id'::text]))),
    CONSTRAINT payment_reversals_reason_check CHECK ((reason = ANY (ARRAY['refund'::text, 'dispute'::text]))),
    CONSTRAINT payment_reversals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text, 'cancelled'::text])))
);

--
-- Name: paypal_coin_orders; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.paypal_coin_orders (
    external_id text NOT NULL,
    matrix_id text NOT NULL,
    amount_cents integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    capture_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT paypal_coin_orders_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT paypal_coin_orders_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text])))
);

--
-- Name: pinned_messages; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.pinned_messages (
    id bigint NOT NULL,
    platform text NOT NULL,
    message_id bigint NOT NULL,
    username text NOT NULL,
    message text NOT NULL,
    emotes jsonb,
    auto boolean DEFAULT false NOT NULL,
    pinned_by text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    unpinned_at timestamp with time zone
);

--
-- Name: pinned_messages_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

CREATE SEQUENCE site.pinned_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: pinned_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: site; Owner: -
--

ALTER SEQUENCE site.pinned_messages_id_seq OWNED BY site.pinned_messages.id;

--
-- Name: platform_account_age; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.platform_account_age (
    platform text NOT NULL,
    platform_id text NOT NULL,
    account_created_at timestamp with time zone,
    checked_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: COLUMN platform_account_age.account_created_at; Type: COMMENT; Schema: site; Owner: -
--

COMMENT ON COLUMN site.platform_account_age.account_created_at IS 'NULL = unknown (platform exposes no date, or returned one predating the platform itself). Never store an epoch date as real.';

--
-- Name: platform_links; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.platform_links (
    matrix_id text NOT NULL,
    platform text NOT NULL,
    platform_id text NOT NULL,
    canonical_id text NOT NULL
);

--
-- Name: platform_mod_actions; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.platform_mod_actions (
    id bigint NOT NULL,
    action text NOT NULL,
    platform text NOT NULL,
    performed_by text NOT NULL,
    target_id text,
    target_platform_id text,
    broadcaster_id text,
    message_id text,
    duration_seconds integer,
    ok boolean NOT NULL,
    status integer,
    detail text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acted_via text,
    platform_ref text,
    batch_id uuid
);

--
-- Name: platform_mod_actions_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

CREATE SEQUENCE site.platform_mod_actions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: platform_mod_actions_id_seq; Type: SEQUENCE OWNED BY; Schema: site; Owner: -
--

ALTER SEQUENCE site.platform_mod_actions_id_seq OWNED BY site.platform_mod_actions.id;

--
-- Name: player_source_snapshots; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.player_source_snapshots (
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    streamplace integer DEFAULT 0 NOT NULL,
    youtube integer DEFAULT 0 NOT NULL,
    twitch integer DEFAULT 0 NOT NULL,
    community integer DEFAULT 0 NOT NULL,
    radio integer DEFAULT 0 NOT NULL,
    folded integer DEFAULT 0 NOT NULL,
    native integer DEFAULT 0 NOT NULL
);

--
-- Name: presence; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.presence (
    matrix_id text NOT NULL,
    last_beat timestamp with time zone,
    last_visible timestamp with time zone,
    last_community timestamp with time zone,
    page text DEFAULT 'other'::text NOT NULL,
    status text DEFAULT 'online'::text NOT NULL,
    status_text text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT presence_status_chk CHECK ((status = ANY (ARRAY['online'::text, 'idle'::text, 'dnd'::text, 'invisible'::text])))
);

--
-- Name: radio_likes; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.radio_likes (
    matrix_id text NOT NULL,
    track_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: reports; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.reports (
    id bigint NOT NULL,
    reported_id text,
    reporter_id text NOT NULL,
    reason text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reported_canonical_id text,
    message_platform text,
    message_id text,
    resolved_by text,
    resolved_at timestamp with time zone,
    CONSTRAINT reports_target_check CHECK (((reported_id IS NOT NULL) OR (reported_canonical_id IS NOT NULL)))
);

--
-- Name: reports_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

CREATE SEQUENCE site.reports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: reports_id_seq; Type: SEQUENCE OWNED BY; Schema: site; Owner: -
--

ALTER SEQUENCE site.reports_id_seq OWNED BY site.reports.id;

--
-- Name: rss_feeds; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.rss_feeds (
    id integer NOT NULL,
    title text NOT NULL,
    url text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_polled_at timestamp with time zone,
    poll_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: rss_feeds_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

CREATE SEQUENCE site.rss_feeds_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: rss_feeds_id_seq; Type: SEQUENCE OWNED BY; Schema: site; Owner: -
--

ALTER SEQUENCE site.rss_feeds_id_seq OWNED BY site.rss_feeds.id;

--
-- Name: rss_items; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.rss_items (
    id bigint NOT NULL,
    feed_id integer NOT NULL,
    guid text NOT NULL,
    title text NOT NULL,
    link text,
    summary text,
    image_url text,
    published_at timestamp with time zone,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: rss_items_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

CREATE SEQUENCE site.rss_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: rss_items_id_seq; Type: SEQUENCE OWNED BY; Schema: site; Owner: -
--

ALTER SEQUENCE site.rss_items_id_seq OWNED BY site.rss_items.id;

--
-- Name: setting_presets; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.setting_presets (
    matrix_id text NOT NULL,
    slot smallint NOT NULL,
    name text,
    settings jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT setting_presets_slot_check CHECK (((slot >= 1) AND (slot <= 4)))
);

--
-- Name: signup_answers; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.signup_answers (
    matrix_id text NOT NULL,
    key text NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: sticker_boosts; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.sticker_boosts (
    id bigint NOT NULL,
    original_message_id bigint NOT NULL,
    booster_matrix_id text NOT NULL,
    coins integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sticker_boosts_coins_check CHECK ((coins > 0))
);

--
-- Name: sticker_boosts_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

CREATE SEQUENCE site.sticker_boosts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: sticker_boosts_id_seq; Type: SEQUENCE OWNED BY; Schema: site; Owner: -
--

ALTER SEQUENCE site.sticker_boosts_id_seq OWNED BY site.sticker_boosts.id;

--
-- Name: store_price_state; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.store_price_state (
    id integer NOT NULL,
    e_value numeric(8,3) NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT store_price_state_e_value_check CHECK ((e_value > (0)::numeric)),
    CONSTRAINT store_price_state_id_check CHECK ((id = 1))
);

--
-- Name: store_prices; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.store_prices (
    item_key text NOT NULL,
    base_streams numeric(8,3) NOT NULL,
    price bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT store_prices_base_streams_check CHECK ((base_streams > (0)::numeric)),
    CONSTRAINT store_prices_price_check CHECK ((price > 0))
);

--
-- Name: stripe_customers; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.stripe_customers (
    stripe_customer_id text NOT NULL,
    matrix_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: style_prices; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.style_prices (
    style_id text NOT NULL,
    price integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT style_prices_price_check CHECK ((price > 0))
);

--
-- Name: subscription_accounts; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.subscription_accounts (
    provider text NOT NULL,
    provider_user_id text NOT NULL,
    matrix_id text NOT NULL,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    linked_via text NOT NULL,
    CONSTRAINT subscription_accounts_linked_via_check CHECK ((linked_via = ANY (ARRAY['oauth'::text, 'code'::text, 'owner-approved'::text]))),
    CONSTRAINT subscription_accounts_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'paypal'::text, 'patreon'::text, 'kofi'::text, 'twitch'::text, 'kick'::text])))
);

--
-- Name: subscription_claims; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.subscription_claims (
    id bigint NOT NULL,
    matrix_id text NOT NULL,
    kind text NOT NULL,
    code_hash text,
    email_hmac text,
    typed_email text,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT subscription_claims_kind_check CHECK ((kind = ANY (ARRAY['code'::text, 'email'::text]))),
    CONSTRAINT subscription_claims_shape CHECK ((((kind = 'code'::text) AND (code_hash IS NOT NULL) AND (email_hmac IS NULL) AND (typed_email IS NULL)) OR ((kind = 'email'::text) AND (code_hash IS NULL) AND (email_hmac IS NOT NULL)))),
    CONSTRAINT subscription_claims_status_check CHECK ((status = ANY (ARRAY['open'::text, 'matched'::text, 'approved'::text, 'refused'::text, 'expired'::text])))
);

--
-- Name: subscription_claims_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

ALTER TABLE site.subscription_claims ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME site.subscription_claims_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: subscription_events; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.subscription_events (
    provider text NOT NULL,
    event_id text NOT NULL,
    event_type text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    occurred_at timestamp with time zone,
    external_id text,
    body jsonb,
    applied_at timestamp with time zone,
    outcome text,
    CONSTRAINT subscription_events_outcome_check CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['applied'::text, 'stale'::text, 'unclaimed'::text, 'ignored'::text])) OR (outcome ~~ 'failed:%'::text))),
    CONSTRAINT subscription_events_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'paypal'::text, 'patreon'::text, 'kofi'::text, 'twitch'::text, 'kick'::text])))
);

--
-- Name: subscription_intents; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.subscription_intents (
    id text NOT NULL,
    matrix_id text NOT NULL,
    provider text NOT NULL,
    tier text NOT NULL,
    plan_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL,
    external_id text,
    price_cents integer,
    currency text,
    CONSTRAINT subscription_intents_currency_check CHECK (((currency IS NULL) OR (currency ~ '^[a-z]{3}$'::text))),
    CONSTRAINT subscription_intents_id_check CHECK ((id ~ '^si_[0-9A-Za-z]{22}$'::text)),
    CONSTRAINT subscription_intents_price_cents_check CHECK (((price_cents IS NULL) OR (price_cents > 0))),
    CONSTRAINT subscription_intents_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'paypal'::text])))
);

--
-- Name: COLUMN subscription_intents.price_cents; Type: COMMENT; Schema: site; Owner: -
--

COMMENT ON COLUMN site.subscription_intents.price_cents IS 'The plan''s monthly price when this subscribe started, in the currency''s minor units: the floor a payment of the subscription must meet to be credited. NULL on intents written before v164.';

--
-- Name: subscription_payments; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.subscription_payments (
    provider text NOT NULL,
    payment_id text NOT NULL,
    record_id bigint NOT NULL,
    amount_cents integer NOT NULL,
    currency text NOT NULL,
    net_cents integer,
    paid_at timestamp with time zone NOT NULL,
    spend_id text,
    credit text,
    refunded_at timestamp with time zone,
    reversed_at timestamp with time zone,
    CONSTRAINT subscription_payments_credit_check CHECK (((credit IS NULL) OR (credit = ANY (ARRAY['pending'::text, 'landed'::text, 'refused'::text])))),
    CONSTRAINT subscription_payments_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'paypal'::text, 'patreon'::text, 'kofi'::text, 'twitch'::text, 'kick'::text])))
);

--
-- Name: subscription_records; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.subscription_records (
    id bigint NOT NULL,
    provider text NOT NULL,
    external_id text NOT NULL,
    matrix_id text,
    account_ref text,
    tier text,
    status text NOT NULL,
    provider_status text NOT NULL,
    renews boolean DEFAULT true NOT NULL,
    period_end timestamp with time zone,
    access_until timestamp with time zone,
    source_event_at timestamp with time zone NOT NULL,
    last_checked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_records_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'paypal'::text, 'patreon'::text, 'kofi'::text, 'twitch'::text, 'kick'::text]))),
    CONSTRAINT subscription_records_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'past_due'::text, 'paused'::text, 'ended'::text])))
);

--
-- Name: TABLE subscription_records; Type: COMMENT; Schema: site; Owner: -
--

COMMENT ON TABLE site.subscription_records IS 'One row per subscription per service (subscription sources, v161). Written only by web subscriptions/state.ts (writeTransition); a viewer is a Supporter while any entitling row is theirs.';

--
-- Name: COLUMN subscription_records.status; Type: COMMENT; Schema: site; Owner: -
--

COMMENT ON COLUMN site.subscription_records.status IS 'Normalised: pending | active | past_due | paused | ended. active and past_due entitle. provider_status keeps the service''s own word.';

--
-- Name: COLUMN subscription_records.access_until; Type: COMMENT; Schema: site; Owner: -
--

COMMENT ON COLUMN site.subscription_records.access_until IS 'NULL = status alone decides (Stripe). Else access stops at this time, with no job and no write.';

--
-- Name: COLUMN subscription_records.source_event_at; Type: COMMENT; Schema: site; Owner: -
--

COMMENT ON COLUMN site.subscription_records.source_event_at IS 'The ordering stamp of the last write; an observation strictly older than it is dropped as stale.';

--
-- Name: subscription_records_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

ALTER TABLE site.subscription_records ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME site.subscription_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: subscriptions; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.subscriptions (
    matrix_id text NOT NULL,
    stripe_customer_id text,
    stripe_sub_id text,
    tier text,
    status text,
    current_period_end timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    stripe_event_at timestamp with time zone,
    cancel_at_period_end boolean DEFAULT false NOT NULL
);

--
-- Name: COLUMN subscriptions.stripe_event_at; Type: COMMENT; Schema: site; Owner: -
--

COMMENT ON COLUMN site.subscriptions.stripe_event_at IS 'Stripe Event.created of the event that last wrote this row. Used by the billing webhook to drop out-of-order deliveries so a stale event cannot resurrect a canceled subscription. NULL = written before migrate-v73.';

--
-- Name: support_tickets; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.support_tickets (
    id bigint NOT NULL,
    matrix_id text NOT NULL,
    kind text NOT NULL,
    body text NOT NULL,
    transcript jsonb,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by text,
    CONSTRAINT support_tickets_kind_check CHECK ((kind = ANY (ARRAY['bug'::text, 'other'::text]))),
    CONSTRAINT support_tickets_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text])))
);

--
-- Name: support_tickets_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

CREATE SEQUENCE site.support_tickets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: support_tickets_id_seq; Type: SEQUENCE OWNED BY; Schema: site; Owner: -
--

ALTER SEQUENCE site.support_tickets_id_seq OWNED BY site.support_tickets.id;

--
-- Name: term_accounts; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.term_accounts (
    matrix_id text NOT NULL,
    packages text[] DEFAULT '{}'::text[] NOT NULL,
    passwd_salt text,
    passwd_hash text,
    passwd_set_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: term_files; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.term_files (
    matrix_id text NOT NULL,
    path text NOT NULL,
    kind text NOT NULL,
    mode text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT term_files_kind_check CHECK ((kind = ANY (ARRAY['file'::text, 'dir'::text])))
);

--
-- Name: term_snapshots; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.term_snapshots (
    matrix_id text NOT NULL,
    day date NOT NULL,
    files jsonb NOT NULL,
    taken_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: term_usage; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.term_usage (
    day date NOT NULL,
    name text NOT NULL,
    hits integer DEFAULT 0 NOT NULL
);

--
-- Name: user_behavior; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.user_behavior (
    matrix_id text NOT NULL,
    hidden jsonb DEFAULT '[]'::jsonb NOT NULL,
    words jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: user_emotes; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.user_emotes (
    matrix_id text NOT NULL,
    emotes jsonb NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: user_marks; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.user_marks (
    id bigint NOT NULL,
    canonical_id text,
    matrix_id text,
    platform text,
    platform_user text,
    reason text NOT NULL,
    source text NOT NULL,
    evidence bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cleared_by text,
    cleared_at timestamp with time zone,
    clear_note text,
    CONSTRAINT user_marks_check CHECK (((canonical_id IS NOT NULL) OR (matrix_id IS NOT NULL)))
);

--
-- Name: user_marks_id_seq; Type: SEQUENCE; Schema: site; Owner: -
--

CREATE SEQUENCE site.user_marks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: user_marks_id_seq; Type: SEQUENCE OWNED BY; Schema: site; Owner: -
--

ALTER SEQUENCE site.user_marks_id_seq OWNED BY site.user_marks.id;

--
-- Name: user_nudges; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.user_nudges (
    matrix_id text NOT NULL,
    kind text NOT NULL,
    dismissed_at timestamp with time zone DEFAULT now() NOT NULL,
    count integer DEFAULT 1 NOT NULL,
    never boolean DEFAULT false NOT NULL
);

--
-- Name: user_sessions; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.user_sessions (
    session_id uuid DEFAULT gen_random_uuid() NOT NULL,
    matrix_id text NOT NULL,
    mx_device_id text NOT NULL,
    mx_access_token text,
    mx_refresh_token text,
    mx_token_expires bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL,
    signed_in_at timestamp with time zone DEFAULT now()
);

--
-- Name: user_settings; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.user_settings (
    matrix_id text NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    device_class text DEFAULT 'desktop'::text NOT NULL,
    CONSTRAINT user_settings_device_class_check CHECK ((device_class = ANY (ARRAY['desktop'::text, 'mobile'::text])))
);

--
-- Name: user_slow_mode; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.user_slow_mode (
    matrix_id text NOT NULL,
    seconds integer NOT NULL,
    expires_at timestamp with time zone,
    set_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_slow_mode_seconds_check CHECK ((seconds > 0))
);

--
-- Name: user_style_unlocks; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.user_style_unlocks (
    matrix_id text NOT NULL,
    style_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: users; Type: TABLE; Schema: site; Owner: -
--

CREATE TABLE site.users (
    matrix_id text NOT NULL,
    display_name text,
    email text,
    avatar_url text,
    is_admin boolean DEFAULT false NOT NULL,
    is_mod boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    username_color character varying(7),
    mx_refresh_token text,
    mx_access_token text,
    mx_token_expires bigint,
    homeserver text,
    oidc_token_endpoint text,
    oidc_client_id text,
    mx_device_id text,
    display_name_changed_at timestamp with time zone,
    profile_synced_at timestamp with time zone,
    username_style jsonb,
    banner_mxc text,
    is_bot boolean DEFAULT false NOT NULL,
    bio text,
    deleted_at timestamp with time zone,
    show_links boolean DEFAULT false NOT NULL
);

--
-- Name: bot_impressions; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.bot_impressions (
    user_id text NOT NULL,
    impression text NOT NULL,
    interactions integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    today text,
    yesterday text,
    today_date date
);

--
-- Name: bot_memory; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.bot_memory (
    id bigint NOT NULL,
    kind text NOT NULL,
    slot text,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bot_memory_kind_check CHECK ((kind = ANY (ARRAY['dynamic'::text, 'lore'::text])))
);

--
-- Name: bot_memory_id_seq; Type: SEQUENCE; Schema: stream; Owner: -
--

CREATE SEQUENCE stream.bot_memory_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: bot_memory_id_seq; Type: SEQUENCE OWNED BY; Schema: stream; Owner: -
--

ALTER SEQUENCE stream.bot_memory_id_seq OWNED BY stream.bot_memory.id;

--
-- Name: bot_responses; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.bot_responses (
    id bigint NOT NULL,
    trigger_kind text NOT NULL,
    trigger_ref text,
    target text,
    user_name text,
    prompt_excerpt text,
    response_text text NOT NULL,
    model text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone
);

--
-- Name: bot_responses_id_seq; Type: SEQUENCE; Schema: stream; Owner: -
--

CREATE SEQUENCE stream.bot_responses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: bot_responses_id_seq; Type: SEQUENCE OWNED BY; Schema: stream; Owner: -
--

ALTER SEQUENCE stream.bot_responses_id_seq OWNED BY stream.bot_responses.id;

--
-- Name: bot_trace; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.bot_trace (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    mode text,
    gear text,
    surface text,
    username text,
    trigger_text text,
    think_used boolean DEFAULT false NOT NULL,
    budget_hit boolean DEFAULT false NOT NULL,
    tool_calls jsonb,
    notes_preview text,
    reply text,
    drop_reason text,
    think_ms integer,
    speak_ms integer,
    total_ms integer,
    tokens_in integer,
    tokens_out integer,
    web_searches integer,
    model text,
    mood text,
    dispatched boolean DEFAULT false NOT NULL,
    snapped boolean DEFAULT false NOT NULL,
    snap_leak_retry boolean DEFAULT false NOT NULL,
    rut_hits jsonb,
    rut_retry_used boolean,
    drift jsonb,
    prompts_hash text
);

--
-- Name: COLUMN bot_trace.rut_hits; Type: COMMENT; Schema: stream; Owner: -
--

COMMENT ON COLUMN stream.bot_trace.rut_hits IS 'P-B phrase governor: the overused 3/4-grams detected in this reply, or [] when clean. NULL = pre-v106.';

--
-- Name: COLUMN bot_trace.rut_retry_used; Type: COMMENT; Schema: stream; Owner: -
--

COMMENT ON COLUMN stream.bot_trace.rut_retry_used IS 'P-B phrase governor: true when the single best-of-two resample was spent on this reply.';

--
-- Name: COLUMN bot_trace.drift; Type: COMMENT; Schema: stream; Owner: -
--

COMMENT ON COLUMN stream.bot_trace.drift IS 'P-C endogenous affect: {weather, lull, simmer, late} as they stood for this generation.';

--
-- Name: bot_trace_id_seq; Type: SEQUENCE; Schema: stream; Owner: -
--

CREATE SEQUENCE stream.bot_trace_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: bot_trace_id_seq; Type: SEQUENCE OWNED BY; Schema: stream; Owner: -
--

ALTER SEQUENCE stream.bot_trace_id_seq OWNED BY stream.bot_trace.id;

--
-- Name: chat_log; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.chat_log (
    id bigint NOT NULL,
    user_id text NOT NULL,
    platform text NOT NULL,
    username text NOT NULL,
    message text NOT NULL,
    stream_id text,
    is_bot boolean DEFAULT false NOT NULL,
    is_mod boolean DEFAULT false NOT NULL,
    is_vip boolean DEFAULT false NOT NULL,
    is_member boolean DEFAULT false NOT NULL,
    karma double precision,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tier text,
    reply_to_id bigint,
    reply_to_username text,
    reply_to_text text,
    emotes jsonb,
    platform_msg_id text,
    username_color text,
    is_deleted boolean DEFAULT false NOT NULL,
    clean_word_count smallint,
    intelligence double precision
);

--
-- Name: chat_log_id_seq; Type: SEQUENCE; Schema: stream; Owner: -
--

CREATE SEQUENCE stream.chat_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: chat_log_id_seq; Type: SEQUENCE OWNED BY; Schema: stream; Owner: -
--

ALTER SEQUENCE stream.chat_log_id_seq OWNED BY stream.chat_log.id;

--
-- Name: erased_restrictions; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.erased_restrictions (
    platform text NOT NULL,
    platform_id text NOT NULL,
    matrix_id text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT erased_restrictions_reason_check CHECK ((reason = ANY (ARRAY['ban'::text, 'case'::text])))
);

--
-- Name: links; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.links (
    platform text NOT NULL,
    platform_id text NOT NULL,
    canonical text NOT NULL
);

--
-- Name: memory_opt_out_platform_ids; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.memory_opt_out_platform_ids (
    platform text NOT NULL,
    platform_id text NOT NULL
);

--
-- Name: message_embeddings; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.message_embeddings (
    id bigint NOT NULL,
    source text NOT NULL,
    source_id bigint NOT NULL,
    username text,
    message text NOT NULL,
    embedding public.vector(1536) NOT NULL,
    model text DEFAULT 'text-embedding-3-small'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    target_name text
);

--
-- Name: message_embeddings_id_seq; Type: SEQUENCE; Schema: stream; Owner: -
--

CREATE SEQUENCE stream.message_embeddings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: message_embeddings_id_seq; Type: SEQUENCE OWNED BY; Schema: stream; Owner: -
--

ALTER SEQUENCE stream.message_embeddings_id_seq OWNED BY stream.message_embeddings.id;

--
-- Name: nameidx; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.nameidx (
    name_lower text NOT NULL,
    canonical text NOT NULL
);

--
-- Name: poll_votes; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.poll_votes (
    poll_id bigint NOT NULL,
    voter_key text NOT NULL,
    option_n integer NOT NULL,
    platform text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: polls; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.polls (
    id bigint NOT NULL,
    stream_id text,
    question text NOT NULL,
    options jsonb NOT NULL,
    created_by text,
    created_by_name text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    status text DEFAULT 'active'::text NOT NULL,
    card_id bigint
);

--
-- Name: polls_id_seq; Type: SEQUENCE; Schema: stream; Owner: -
--

CREATE SEQUENCE stream.polls_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: polls_id_seq; Type: SEQUENCE OWNED BY; Schema: stream; Owner: -
--

ALTER SEQUENCE stream.polls_id_seq OWNED BY stream.polls.id;

--
-- Name: radio_tracks; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.radio_tracks (
    id integer NOT NULL,
    kind text DEFAULT 'song'::text NOT NULL,
    filename text NOT NULL,
    mime text DEFAULT 'audio/mpeg'::text NOT NULL,
    duration_s real,
    bytes bigint,
    title text,
    artist text,
    genre text,
    segment_type text,
    intro_track_id integer,
    transcript text,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    generated_at timestamp with time zone,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT radio_tracks_kind_check CHECK ((kind = ANY (ARRAY['song'::text, 'dj'::text]))),
    CONSTRAINT radio_tracks_segment_type_check CHECK ((segment_type = ANY (ARRAY['news'::text, 'station_id'::text, 'shoutout'::text, 'banter'::text])))
);

--
-- Name: radio_tracks_id_seq; Type: SEQUENCE; Schema: stream; Owner: -
--

CREATE SEQUENCE stream.radio_tracks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: radio_tracks_id_seq; Type: SEQUENCE OWNED BY; Schema: stream; Owner: -
--

ALTER SEQUENCE stream.radio_tracks_id_seq OWNED BY stream.radio_tracks.id;

--
-- Name: support_events; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.support_events (
    id bigint NOT NULL,
    user_id text NOT NULL,
    platform text NOT NULL,
    username text NOT NULL,
    amount_usd numeric(10,2) NOT NULL,
    event_type text,
    stream_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tier text,
    months integer,
    event_id text,
    reverses_id bigint,
    admitted_usd numeric(10,2),
    CONSTRAINT support_events_admitted_usd_range CHECK (((admitted_usd IS NULL) OR ((admitted_usd >= (0)::numeric) AND (admitted_usd <= amount_usd)))),
    CONSTRAINT support_events_reversal_shape CHECK (((reverses_id IS NULL) OR ((event_type = ANY (ARRAY['reversal'::text, 'reversal-restore'::text])) AND (stream_id IS NULL))))
);

--
-- Name: COLUMN support_events.admitted_usd; Type: COMMENT; Schema: stream; Owner: -
--

COMMENT ON COLUMN stream.support_events.admitted_usd IS 'Amount of this credit the per-stream support bar and the timer admitted: its net after any refunds already recorded before it landed. NULL = the whole amount_usd.';

--
-- Name: support_events_id_seq; Type: SEQUENCE; Schema: stream; Owner: -
--

CREATE SEQUENCE stream.support_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: support_events_id_seq; Type: SEQUENCE OWNED BY; Schema: stream; Owner: -
--

ALTER SEQUENCE stream.support_events_id_seq OWNED BY stream.support_events.id;

--
-- Name: support_reversal_holds; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.support_reversal_holds (
    event_id text NOT NULL,
    ref text NOT NULL,
    reason text,
    share numeric,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_reversal_holds_opened_has_reason CHECK (((status = 'cancelled'::text) OR (reason IS NOT NULL))),
    CONSTRAINT support_reversal_holds_reason_check CHECK ((reason = ANY (ARRAY['refund'::text, 'dispute'::text]))),
    CONSTRAINT support_reversal_holds_share_check CHECK (((share > (0)::numeric) AND (share <= (1)::numeric))),
    CONSTRAINT support_reversal_holds_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text, 'cancelled'::text])))
);

--
-- Name: timer_state; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.timer_state (
    id smallint DEFAULT 1 NOT NULL,
    running boolean DEFAULT false NOT NULL,
    remaining_sec numeric DEFAULT 10800 NOT NULL,
    cap_enabled boolean DEFAULT true NOT NULL,
    cap_sec integer DEFAULT 28800 NOT NULL,
    usd_per_hour numeric DEFAULT 40 NOT NULL,
    fill_usd numeric DEFAULT 200 NOT NULL,
    base_sec integer DEFAULT 10800 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    lock_at_zero boolean DEFAULT false NOT NULL,
    low_pulse_enabled boolean DEFAULT true NOT NULL,
    low_threshold_sec integer DEFAULT 300 NOT NULL,
    low_ramp_rate numeric DEFAULT 1.6 NOT NULL,
    low_glow_max numeric DEFAULT 0.55 NOT NULL,
    night_active boolean DEFAULT false NOT NULL,
    night_duration_sec integer DEFAULT 0 NOT NULL,
    night_elapsed_sec integer DEFAULT 0 NOT NULL,
    night_seed_sec integer DEFAULT 7200 NOT NULL,
    night_price_cents integer DEFAULT 0 NOT NULL,
    night_blocks jsonb,
    night_overflow_cents integer DEFAULT 0 NOT NULL,
    night_started_at timestamp with time zone,
    CONSTRAINT timer_state_id_check CHECK ((id = 1))
);

--
-- Name: COLUMN timer_state.lock_at_zero; Type: COMMENT; Schema: stream; Owner: -
--

COMMENT ON COLUMN stream.timer_state.lock_at_zero IS 'LEGACY (v111): retired by Fund the Night — kept for pre-v111 rollback only.';

--
-- Name: unpriced_support; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.unpriced_support (
    id bigint NOT NULL,
    event_id text,
    platform text NOT NULL,
    event_type text,
    user_id text,
    username text NOT NULL,
    amount_native numeric NOT NULL,
    currency text NOT NULL,
    raw text,
    message text,
    stream_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    reconciled_at timestamp with time zone,
    reconciled_amount_usd numeric(10,2),
    reason text DEFAULT 'unpriced'::text NOT NULL,
    CONSTRAINT unpriced_support_reason_check CHECK ((reason = ANY (ARRAY['unpriced'::text, 'ledger_failed'::text]))),
    CONSTRAINT unpriced_support_status_check CHECK ((status = ANY (ARRAY['open'::text, 'reconciled'::text, 'dismissed'::text])))
);

--
-- Name: unpriced_support_id_seq; Type: SEQUENCE; Schema: stream; Owner: -
--

CREATE SEQUENCE stream.unpriced_support_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: unpriced_support_id_seq; Type: SEQUENCE OWNED BY; Schema: stream; Owner: -
--

ALTER SEQUENCE stream.unpriced_support_id_seq OWNED BY stream.unpriced_support.id;

--
-- Name: user_stats; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.user_stats (
    user_id text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    activity bigint DEFAULT 0 NOT NULL,
    streams bigint DEFAULT 0 NOT NULL,
    support numeric(10,2) DEFAULT 0 NOT NULL,
    karma double precision DEFAULT 0.5 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_member boolean DEFAULT false NOT NULL,
    sub_tier text,
    avg_message_words double precision,
    intelligence double precision,
    std_karma double precision,
    extreme_pct integer,
    intelligence_pct integer,
    karma_pct integer,
    intelligence_tier text,
    regularity_tier text,
    support_tier text,
    temperament_label text,
    word_count_tier text
);

--
-- Name: users; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.users (
    id text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL,
    nickname text,
    pronouns text,
    timezone text,
    avatar_url text,
    pronouns_source text,
    alejo_checked_at timestamp with time zone,
    CONSTRAINT users_pronouns_source_check CHECK ((pronouns_source = ANY (ARRAY['self'::text, 'mod'::text, 'alejo'::text])))
);

--
-- Name: viewer_snapshots; Type: TABLE; Schema: stream; Owner: -
--

CREATE TABLE stream.viewer_snapshots (
    id bigint NOT NULL,
    stream_id text,
    twitch integer,
    youtube integer,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    kick integer,
    streamplace integer,
    total integer GENERATED ALWAYS AS ((((COALESCE(twitch, 0) + COALESCE(youtube, 0)) + COALESCE(kick, 0)) + COALESCE(streamplace, 0))) STORED
);

--
-- Name: viewer_snapshots_id_seq; Type: SEQUENCE; Schema: stream; Owner: -
--

CREATE SEQUENCE stream.viewer_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: viewer_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: stream; Owner: -
--

ALTER SEQUENCE stream.viewer_snapshots_id_seq OWNED BY stream.viewer_snapshots.id;

--
-- Name: automod_held id; Type: DEFAULT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.automod_held ALTER COLUMN id SET DEFAULT nextval('site.automod_held_id_seq'::regclass);

--
-- Name: badges id; Type: DEFAULT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.badges ALTER COLUMN id SET DEFAULT nextval('site.badges_id_seq'::regclass);

--
-- Name: chat_messages id; Type: DEFAULT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.chat_messages ALTER COLUMN id SET DEFAULT nextval('site.chat_messages_id_seq'::regclass);

--
-- Name: coin_ledger id; Type: DEFAULT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.coin_ledger ALTER COLUMN id SET DEFAULT nextval('site.coin_ledger_id_seq'::regclass);

--
-- Name: community_embeds id; Type: DEFAULT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.community_embeds ALTER COLUMN id SET DEFAULT nextval('site.community_embeds_id_seq'::regclass);

--
-- Name: community_loop_videos id; Type: DEFAULT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.community_loop_videos ALTER COLUMN id SET DEFAULT nextval('site.community_loop_videos_id_seq'::regclass);

--
-- Name: instance_history id; Type: DEFAULT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.instance_history ALTER COLUMN id SET DEFAULT nextval('site.instance_history_id_seq'::regclass);

--
-- Name: mod_log id; Type: DEFAULT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.mod_log ALTER COLUMN id SET DEFAULT nextval('site.mod_log_id_seq'::regclass);

--
-- Name: pinned_messages id; Type: DEFAULT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.pinned_messages ALTER COLUMN id SET DEFAULT nextval('site.pinned_messages_id_seq'::regclass);

--
-- Name: platform_mod_actions id; Type: DEFAULT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.platform_mod_actions ALTER COLUMN id SET DEFAULT nextval('site.platform_mod_actions_id_seq'::regclass);

--
-- Name: reports id; Type: DEFAULT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.reports ALTER COLUMN id SET DEFAULT nextval('site.reports_id_seq'::regclass);

--
-- Name: rss_feeds id; Type: DEFAULT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.rss_feeds ALTER COLUMN id SET DEFAULT nextval('site.rss_feeds_id_seq'::regclass);

--
-- Name: rss_items id; Type: DEFAULT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.rss_items ALTER COLUMN id SET DEFAULT nextval('site.rss_items_id_seq'::regclass);

--
-- Name: sticker_boosts id; Type: DEFAULT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.sticker_boosts ALTER COLUMN id SET DEFAULT nextval('site.sticker_boosts_id_seq'::regclass);

--
-- Name: support_tickets id; Type: DEFAULT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.support_tickets ALTER COLUMN id SET DEFAULT nextval('site.support_tickets_id_seq'::regclass);

--
-- Name: user_marks id; Type: DEFAULT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.user_marks ALTER COLUMN id SET DEFAULT nextval('site.user_marks_id_seq'::regclass);

--
-- Name: bot_memory id; Type: DEFAULT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.bot_memory ALTER COLUMN id SET DEFAULT nextval('stream.bot_memory_id_seq'::regclass);

--
-- Name: bot_responses id; Type: DEFAULT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.bot_responses ALTER COLUMN id SET DEFAULT nextval('stream.bot_responses_id_seq'::regclass);

--
-- Name: bot_trace id; Type: DEFAULT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.bot_trace ALTER COLUMN id SET DEFAULT nextval('stream.bot_trace_id_seq'::regclass);

--
-- Name: chat_log id; Type: DEFAULT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.chat_log ALTER COLUMN id SET DEFAULT nextval('stream.chat_log_id_seq'::regclass);

--
-- Name: message_embeddings id; Type: DEFAULT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.message_embeddings ALTER COLUMN id SET DEFAULT nextval('stream.message_embeddings_id_seq'::regclass);

--
-- Name: polls id; Type: DEFAULT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.polls ALTER COLUMN id SET DEFAULT nextval('stream.polls_id_seq'::regclass);

--
-- Name: radio_tracks id; Type: DEFAULT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.radio_tracks ALTER COLUMN id SET DEFAULT nextval('stream.radio_tracks_id_seq'::regclass);

--
-- Name: support_events id; Type: DEFAULT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.support_events ALTER COLUMN id SET DEFAULT nextval('stream.support_events_id_seq'::regclass);

--
-- Name: unpriced_support id; Type: DEFAULT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.unpriced_support ALTER COLUMN id SET DEFAULT nextval('stream.unpriced_support_id_seq'::regclass);

--
-- Name: viewer_snapshots id; Type: DEFAULT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.viewer_snapshots ALTER COLUMN id SET DEFAULT nextval('stream.viewer_snapshots_id_seq'::regclass);

--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);

--
-- Name: account_deletions account_deletions_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.account_deletions
    ADD CONSTRAINT account_deletions_pkey PRIMARY KEY (matrix_id);

--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);

--
-- Name: accounts accounts_provider_provider_account_id_key; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.accounts
    ADD CONSTRAINT accounts_provider_provider_account_id_key UNIQUE (provider, provider_account_id);

--
-- Name: ai_slots ai_slots_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.ai_slots
    ADD CONSTRAINT ai_slots_pkey PRIMARY KEY (slot_id);

--
-- Name: ai_usage ai_usage_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.ai_usage
    ADD CONSTRAINT ai_usage_pkey PRIMARY KEY (day, slot_id, connection_id, model);

--
-- Name: atproto_oauth_state atproto_oauth_state_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.atproto_oauth_state
    ADD CONSTRAINT atproto_oauth_state_pkey PRIMARY KEY (key);

--
-- Name: atproto_sessions atproto_sessions_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.atproto_sessions
    ADD CONSTRAINT atproto_sessions_pkey PRIMARY KEY (did);

--
-- Name: automod_held automod_held_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.automod_held
    ADD CONSTRAINT automod_held_pkey PRIMARY KEY (id);

--
-- Name: automod_held automod_held_twitch_msg_id_key; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.automod_held
    ADD CONSTRAINT automod_held_twitch_msg_id_key UNIQUE (twitch_msg_id);

--
-- Name: badge_slots badge_slots_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.badge_slots
    ADD CONSTRAINT badge_slots_pkey PRIMARY KEY (matrix_id);

--
-- Name: badge_unlocks badge_unlocks_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.badge_unlocks
    ADD CONSTRAINT badge_unlocks_pkey PRIMARY KEY (matrix_id, badge_id);

--
-- Name: badges badges_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.badges
    ADD CONSTRAINT badges_pkey PRIMARY KEY (id);

--
-- Name: bans bans_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.bans
    ADD CONSTRAINT bans_pkey PRIMARY KEY (matrix_id);

--
-- Name: blocklist_overrides blocklist_overrides_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.blocklist_overrides
    ADD CONSTRAINT blocklist_overrides_pkey PRIMARY KEY (kind, term);

--
-- Name: chat_message_platform_copies chat_message_platform_copies_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.chat_message_platform_copies
    ADD CONSTRAINT chat_message_platform_copies_pkey PRIMARY KEY (site_msg_id, platform);

--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);

--
-- Name: chat_settings chat_settings_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.chat_settings
    ADD CONSTRAINT chat_settings_pkey PRIMARY KEY (id);

--
-- Name: client_errors client_errors_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.client_errors
    ADD CONSTRAINT client_errors_pkey PRIMARY KEY (fingerprint);

--
-- Name: coin_earn_stream coin_earn_stream_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.coin_earn_stream
    ADD CONSTRAINT coin_earn_stream_pkey PRIMARY KEY (matrix_id, stream_id);

--
-- Name: coin_earn_upvotes coin_earn_upvotes_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.coin_earn_upvotes
    ADD CONSTRAINT coin_earn_upvotes_pkey PRIMARY KEY (recipient, voter, stream_id);

--
-- Name: coin_ledger coin_ledger_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.coin_ledger
    ADD CONSTRAINT coin_ledger_pkey PRIMARY KEY (id);

--
-- Name: coin_wallets coin_wallets_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.coin_wallets
    ADD CONSTRAINT coin_wallets_pkey PRIMARY KEY (matrix_id);

--
-- Name: community_embeds community_embeds_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.community_embeds
    ADD CONSTRAINT community_embeds_pkey PRIMARY KEY (id);

--
-- Name: community_loop_videos community_loop_videos_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.community_loop_videos
    ADD CONSTRAINT community_loop_videos_pkey PRIMARY KEY (id);

--
-- Name: device_health device_health_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.device_health
    ADD CONSTRAINT device_health_pkey PRIMARY KEY (session_id);

--
-- Name: donations donations_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.donations
    ADD CONSTRAINT donations_pkey PRIMARY KEY (id);

--
-- Name: donations donations_provider_external_key; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.donations
    ADD CONSTRAINT donations_provider_external_key UNIQUE (provider, external_id);

--
-- Name: donations donations_stripe_session_id_key; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.donations
    ADD CONSTRAINT donations_stripe_session_id_key UNIQUE (stripe_session_id);

--
-- Name: federated_pending federated_pending_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.federated_pending
    ADD CONSTRAINT federated_pending_pkey PRIMARY KEY (token);

--
-- Name: forum_pins forum_pins_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.forum_pins
    ADD CONSTRAINT forum_pins_pkey PRIMARY KEY (room_id, event_id);

--
-- Name: forum_votes forum_votes_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.forum_votes
    ADD CONSTRAINT forum_votes_pkey PRIMARY KEY (room_id, event_id, voter_matrix_id);

--
-- Name: gift_pending gift_pending_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.gift_pending
    ADD CONSTRAINT gift_pending_pkey PRIMARY KEY (id);

--
-- Name: gift_subscriptions gift_subscriptions_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.gift_subscriptions
    ADD CONSTRAINT gift_subscriptions_pkey PRIMARY KEY (id);

--
-- Name: gift_subscriptions gift_subscriptions_stripe_session_id_recipient_matrix_id_key; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.gift_subscriptions
    ADD CONSTRAINT gift_subscriptions_stripe_session_id_recipient_matrix_id_key UNIQUE (stripe_session_id, recipient_matrix_id);

--
-- Name: house_looks house_looks_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.house_looks
    ADD CONSTRAINT house_looks_pkey PRIMARY KEY (slot);

--
-- Name: instance_config instance_config_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.instance_config
    ADD CONSTRAINT instance_config_pkey PRIMARY KEY (key);

--
-- Name: instance_content instance_content_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.instance_content
    ADD CONSTRAINT instance_content_pkey PRIMARY KEY (key);

--
-- Name: instance_history instance_history_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.instance_history
    ADD CONSTRAINT instance_history_pkey PRIMARY KEY (id);

--
-- Name: instance_secret_tests instance_secret_tests_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.instance_secret_tests
    ADD CONSTRAINT instance_secret_tests_pkey PRIMARY KEY (key, package);

--
-- Name: instance_secrets instance_secrets_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.instance_secrets
    ADD CONSTRAINT instance_secrets_pkey PRIMARY KEY (key);

--
-- Name: lockdown lockdown_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.lockdown
    ADD CONSTRAINT lockdown_pkey PRIMARY KEY (id);

--
-- Name: memory_opt_outs memory_opt_outs_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.memory_opt_outs
    ADD CONSTRAINT memory_opt_outs_pkey PRIMARY KEY (matrix_id);

--
-- Name: message_votes message_votes_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.message_votes
    ADD CONSTRAINT message_votes_pkey PRIMARY KEY (platform, message_id, voter_matrix_id);

--
-- Name: mod_log mod_log_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.mod_log
    ADD CONSTRAINT mod_log_pkey PRIMARY KEY (id);

--
-- Name: payment_events payment_events_event_id_key; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.payment_events
    ADD CONSTRAINT payment_events_event_id_key UNIQUE (event_id);

--
-- Name: payment_events payment_events_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.payment_events
    ADD CONSTRAINT payment_events_pkey PRIMARY KEY (id);

--
-- Name: payment_reversals payment_reversals_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.payment_reversals
    ADD CONSTRAINT payment_reversals_pkey PRIMARY KEY (ref);

--
-- Name: paypal_coin_orders paypal_coin_orders_capture_id_key; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.paypal_coin_orders
    ADD CONSTRAINT paypal_coin_orders_capture_id_key UNIQUE (capture_id);

--
-- Name: paypal_coin_orders paypal_coin_orders_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.paypal_coin_orders
    ADD CONSTRAINT paypal_coin_orders_pkey PRIMARY KEY (external_id);

--
-- Name: pinned_messages pinned_messages_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.pinned_messages
    ADD CONSTRAINT pinned_messages_pkey PRIMARY KEY (id);

--
-- Name: platform_account_age platform_account_age_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.platform_account_age
    ADD CONSTRAINT platform_account_age_pkey PRIMARY KEY (platform, platform_id);

--
-- Name: platform_links platform_links_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.platform_links
    ADD CONSTRAINT platform_links_pkey PRIMARY KEY (matrix_id, platform);

--
-- Name: platform_mod_actions platform_mod_actions_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.platform_mod_actions
    ADD CONSTRAINT platform_mod_actions_pkey PRIMARY KEY (id);

--
-- Name: presence presence_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.presence
    ADD CONSTRAINT presence_pkey PRIMARY KEY (matrix_id);

--
-- Name: radio_likes radio_likes_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.radio_likes
    ADD CONSTRAINT radio_likes_pkey PRIMARY KEY (matrix_id, track_id);

--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (id);

--
-- Name: rss_feeds rss_feeds_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.rss_feeds
    ADD CONSTRAINT rss_feeds_pkey PRIMARY KEY (id);

--
-- Name: rss_feeds rss_feeds_url_key; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.rss_feeds
    ADD CONSTRAINT rss_feeds_url_key UNIQUE (url);

--
-- Name: rss_items rss_items_feed_id_guid_key; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.rss_items
    ADD CONSTRAINT rss_items_feed_id_guid_key UNIQUE (feed_id, guid);

--
-- Name: rss_items rss_items_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.rss_items
    ADD CONSTRAINT rss_items_pkey PRIMARY KEY (id);

--
-- Name: setting_presets setting_presets_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.setting_presets
    ADD CONSTRAINT setting_presets_pkey PRIMARY KEY (matrix_id, slot);

--
-- Name: signup_answers signup_answers_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.signup_answers
    ADD CONSTRAINT signup_answers_pkey PRIMARY KEY (matrix_id, key);

--
-- Name: sticker_boosts sticker_boosts_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.sticker_boosts
    ADD CONSTRAINT sticker_boosts_pkey PRIMARY KEY (id);

--
-- Name: store_price_state store_price_state_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.store_price_state
    ADD CONSTRAINT store_price_state_pkey PRIMARY KEY (id);

--
-- Name: store_prices store_prices_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.store_prices
    ADD CONSTRAINT store_prices_pkey PRIMARY KEY (item_key);

--
-- Name: stripe_customers stripe_customers_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.stripe_customers
    ADD CONSTRAINT stripe_customers_pkey PRIMARY KEY (stripe_customer_id);

--
-- Name: style_prices style_prices_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.style_prices
    ADD CONSTRAINT style_prices_pkey PRIMARY KEY (style_id);

--
-- Name: subscription_accounts subscription_accounts_one_per_service; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.subscription_accounts
    ADD CONSTRAINT subscription_accounts_one_per_service UNIQUE (provider, matrix_id);

--
-- Name: subscription_accounts subscription_accounts_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.subscription_accounts
    ADD CONSTRAINT subscription_accounts_pkey PRIMARY KEY (provider, provider_user_id);

--
-- Name: subscription_claims subscription_claims_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.subscription_claims
    ADD CONSTRAINT subscription_claims_pkey PRIMARY KEY (id);

--
-- Name: subscription_events subscription_events_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.subscription_events
    ADD CONSTRAINT subscription_events_pkey PRIMARY KEY (provider, event_id);

--
-- Name: subscription_intents subscription_intents_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.subscription_intents
    ADD CONSTRAINT subscription_intents_pkey PRIMARY KEY (id);

--
-- Name: subscription_payments subscription_payments_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.subscription_payments
    ADD CONSTRAINT subscription_payments_pkey PRIMARY KEY (provider, payment_id);

--
-- Name: subscription_records subscription_records_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.subscription_records
    ADD CONSTRAINT subscription_records_pkey PRIMARY KEY (id);

--
-- Name: subscription_records subscription_records_provider_external_key; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.subscription_records
    ADD CONSTRAINT subscription_records_provider_external_key UNIQUE (provider, external_id);

--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (matrix_id);

--
-- Name: support_tickets support_tickets_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.support_tickets
    ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (id);

--
-- Name: term_accounts term_accounts_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.term_accounts
    ADD CONSTRAINT term_accounts_pkey PRIMARY KEY (matrix_id);

--
-- Name: term_files term_files_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.term_files
    ADD CONSTRAINT term_files_pkey PRIMARY KEY (matrix_id, path);

--
-- Name: term_snapshots term_snapshots_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.term_snapshots
    ADD CONSTRAINT term_snapshots_pkey PRIMARY KEY (matrix_id, day);

--
-- Name: term_usage term_usage_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.term_usage
    ADD CONSTRAINT term_usage_pkey PRIMARY KEY (day, name);

--
-- Name: user_behavior user_behavior_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.user_behavior
    ADD CONSTRAINT user_behavior_pkey PRIMARY KEY (matrix_id);

--
-- Name: user_emotes user_emotes_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.user_emotes
    ADD CONSTRAINT user_emotes_pkey PRIMARY KEY (matrix_id);

--
-- Name: user_marks user_marks_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.user_marks
    ADD CONSTRAINT user_marks_pkey PRIMARY KEY (id);

--
-- Name: user_nudges user_nudges_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.user_nudges
    ADD CONSTRAINT user_nudges_pkey PRIMARY KEY (matrix_id, kind);

--
-- Name: user_sessions user_sessions_matrix_id_mx_device_id_key; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.user_sessions
    ADD CONSTRAINT user_sessions_matrix_id_mx_device_id_key UNIQUE (matrix_id, mx_device_id);

--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (session_id);

--
-- Name: user_settings user_settings_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.user_settings
    ADD CONSTRAINT user_settings_pkey PRIMARY KEY (matrix_id, device_class);

--
-- Name: user_slow_mode user_slow_mode_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.user_slow_mode
    ADD CONSTRAINT user_slow_mode_pkey PRIMARY KEY (matrix_id);

--
-- Name: user_style_unlocks user_style_unlocks_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.user_style_unlocks
    ADD CONSTRAINT user_style_unlocks_pkey PRIMARY KEY (matrix_id, style_id);

--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (matrix_id);

--
-- Name: bot_impressions bot_impressions_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.bot_impressions
    ADD CONSTRAINT bot_impressions_pkey PRIMARY KEY (user_id);

--
-- Name: bot_memory bot_memory_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.bot_memory
    ADD CONSTRAINT bot_memory_pkey PRIMARY KEY (id);

--
-- Name: bot_responses bot_responses_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.bot_responses
    ADD CONSTRAINT bot_responses_pkey PRIMARY KEY (id);

--
-- Name: bot_trace bot_trace_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.bot_trace
    ADD CONSTRAINT bot_trace_pkey PRIMARY KEY (id);

--
-- Name: chat_log chat_log_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.chat_log
    ADD CONSTRAINT chat_log_pkey PRIMARY KEY (id);

--
-- Name: erased_restrictions erased_restrictions_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.erased_restrictions
    ADD CONSTRAINT erased_restrictions_pkey PRIMARY KEY (platform, platform_id);

--
-- Name: links links_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.links
    ADD CONSTRAINT links_pkey PRIMARY KEY (platform, platform_id);

--
-- Name: memory_opt_out_platform_ids memory_opt_out_platform_ids_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.memory_opt_out_platform_ids
    ADD CONSTRAINT memory_opt_out_platform_ids_pkey PRIMARY KEY (platform, platform_id);

--
-- Name: message_embeddings message_embeddings_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.message_embeddings
    ADD CONSTRAINT message_embeddings_pkey PRIMARY KEY (id);

--
-- Name: message_embeddings message_embeddings_source_source_id_key; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.message_embeddings
    ADD CONSTRAINT message_embeddings_source_source_id_key UNIQUE (source, source_id);

--
-- Name: nameidx nameidx_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.nameidx
    ADD CONSTRAINT nameidx_pkey PRIMARY KEY (name_lower);

--
-- Name: poll_votes poll_votes_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.poll_votes
    ADD CONSTRAINT poll_votes_pkey PRIMARY KEY (poll_id, voter_key);

--
-- Name: polls polls_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.polls
    ADD CONSTRAINT polls_pkey PRIMARY KEY (id);

--
-- Name: radio_tracks radio_tracks_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.radio_tracks
    ADD CONSTRAINT radio_tracks_pkey PRIMARY KEY (id);

--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (stream_id);

--
-- Name: support_events support_events_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.support_events
    ADD CONSTRAINT support_events_pkey PRIMARY KEY (id);

--
-- Name: support_reversal_holds support_reversal_holds_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.support_reversal_holds
    ADD CONSTRAINT support_reversal_holds_pkey PRIMARY KEY (event_id, ref);

--
-- Name: timer_state timer_state_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.timer_state
    ADD CONSTRAINT timer_state_pkey PRIMARY KEY (id);

--
-- Name: unpriced_support unpriced_support_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.unpriced_support
    ADD CONSTRAINT unpriced_support_pkey PRIMARY KEY (id);

--
-- Name: user_stats user_stats_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.user_stats
    ADD CONSTRAINT user_stats_pkey PRIMARY KEY (user_id);

--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

--
-- Name: viewer_snapshots viewer_snapshots_pkey; Type: CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.viewer_snapshots
    ADD CONSTRAINT viewer_snapshots_pkey PRIMARY KEY (id);

--
-- Name: accounts_matrix_id_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX accounts_matrix_id_idx ON site.accounts USING btree (matrix_id);

--
-- Name: automod_held_actionable_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX automod_held_actionable_idx ON site.automod_held USING btree (held_at DESC) WHERE (status = ANY (ARRAY['pending'::text, 'blocked'::text]));

--
-- Name: automod_held_pending_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX automod_held_pending_idx ON site.automod_held USING btree (held_at DESC) WHERE (status = 'pending'::text);

--
-- Name: badge_unlocks_matrix_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX badge_unlocks_matrix_idx ON site.badge_unlocks USING btree (matrix_id);

--
-- Name: badges_one_mod; Type: INDEX; Schema: site; Owner: -
--

CREATE UNIQUE INDEX badges_one_mod ON site.badges USING btree (is_mod) WHERE is_mod;

--
-- Name: badges_one_subscriber; Type: INDEX; Schema: site; Owner: -
--

CREATE UNIQUE INDEX badges_one_subscriber ON site.badges USING btree (is_subscriber) WHERE is_subscriber;

--
-- Name: client_errors_last_seen_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX client_errors_last_seen_idx ON site.client_errors USING btree (last_seen DESC);

--
-- Name: client_errors_occurrences_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX client_errors_occurrences_idx ON site.client_errors USING btree (occurrences DESC);

--
-- Name: coin_ledger_kind_ref; Type: INDEX; Schema: site; Owner: -
--

CREATE UNIQUE INDEX coin_ledger_kind_ref ON site.coin_ledger USING btree (kind, ref) WHERE (ref IS NOT NULL);

--
-- Name: coin_ledger_matrix_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX coin_ledger_matrix_idx ON site.coin_ledger USING btree (matrix_id, id DESC);

--
-- Name: community_loop_videos_priority_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX community_loop_videos_priority_idx ON site.community_loop_videos USING btree (priority);

--
-- Name: community_loop_videos_video_id_key; Type: INDEX; Schema: site; Owner: -
--

CREATE UNIQUE INDEX community_loop_videos_video_id_key ON site.community_loop_videos USING btree (video_id);

--
-- Name: device_health_last_at_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX device_health_last_at_idx ON site.device_health USING btree (last_at DESC);

--
-- Name: donations_created_at_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX donations_created_at_idx ON site.donations USING btree (created_at DESC);

--
-- Name: donations_matrix_id_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX donations_matrix_id_idx ON site.donations USING btree (matrix_id);

--
-- Name: donations_provider_status_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX donations_provider_status_idx ON site.donations USING btree (provider, status);

--
-- Name: federated_pending_expires; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX federated_pending_expires ON site.federated_pending USING btree (expires_at);

--
-- Name: forum_pins_room_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX forum_pins_room_idx ON site.forum_pins USING btree (room_id);

--
-- Name: forum_votes_author_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX forum_votes_author_idx ON site.forum_votes USING btree (author_matrix_id);

--
-- Name: forum_votes_event_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX forum_votes_event_idx ON site.forum_votes USING btree (room_id, event_id);

--
-- Name: gift_pending_unclaimed_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX gift_pending_unclaimed_idx ON site.gift_pending USING btree (created_at) WHERE (claimed_by IS NULL);

--
-- Name: gift_subs_expires_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX gift_subs_expires_idx ON site.gift_subscriptions USING btree (expires_at);

--
-- Name: gift_subs_recipient_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX gift_subs_recipient_idx ON site.gift_subscriptions USING btree (recipient_matrix_id, expires_at DESC);

--
-- Name: idx_chat_messages_created_at; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX idx_chat_messages_created_at ON site.chat_messages USING btree (created_at DESC);

--
-- Name: idx_chat_messages_message_trgm; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX idx_chat_messages_message_trgm ON site.chat_messages USING gin (message public.gin_trgm_ops);

--
-- Name: idx_rss_items_summary_trgm; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX idx_rss_items_summary_trgm ON site.rss_items USING gin (summary public.gin_trgm_ops);

--
-- Name: idx_rss_items_title_trgm; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX idx_rss_items_title_trgm ON site.rss_items USING gin (title public.gin_trgm_ops);

--
-- Name: instance_history_key_time; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX instance_history_key_time ON site.instance_history USING btree (key, updated_at DESC);

--
-- Name: message_votes_msg_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX message_votes_msg_idx ON site.message_votes USING btree (platform, message_id);

--
-- Name: mod_log_created_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX mod_log_created_idx ON site.mod_log USING btree (created_at DESC);

--
-- Name: mod_log_target_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX mod_log_target_idx ON site.mod_log USING btree (target_id, created_at DESC);

--
-- Name: one_open_mark; Type: INDEX; Schema: site; Owner: -
--

CREATE UNIQUE INDEX one_open_mark ON site.user_marks USING btree (COALESCE(canonical_id, matrix_id)) WHERE (cleared_at IS NULL);

--
-- Name: payment_events_occurred_at_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX payment_events_occurred_at_idx ON site.payment_events USING btree (occurred_at DESC);

--
-- Name: payment_events_session_id_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX payment_events_session_id_idx ON site.payment_events USING btree (session_id);

--
-- Name: payment_reversals_pending; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX payment_reversals_pending ON site.payment_reversals USING btree (payment_key, payment_id) WHERE (status = 'pending'::text);

--
-- Name: pinned_messages_msg_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX pinned_messages_msg_idx ON site.pinned_messages USING btree (platform, message_id);

--
-- Name: pinned_messages_one_active; Type: INDEX; Schema: site; Owner: -
--

CREATE UNIQUE INDEX pinned_messages_one_active ON site.pinned_messages USING btree (active) WHERE active;

--
-- Name: platform_account_age_checked_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX platform_account_age_checked_idx ON site.platform_account_age USING btree (checked_at);

--
-- Name: platform_links_platform_id_uq; Type: INDEX; Schema: site; Owner: -
--

CREATE UNIQUE INDEX platform_links_platform_id_uq ON site.platform_links USING btree (platform, platform_id);

--
-- Name: platform_mod_actions_batch_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX platform_mod_actions_batch_idx ON site.platform_mod_actions USING btree (batch_id) WHERE (batch_id IS NOT NULL);

--
-- Name: platform_mod_actions_created_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX platform_mod_actions_created_idx ON site.platform_mod_actions USING btree (created_at DESC);

--
-- Name: platform_mod_actions_target_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX platform_mod_actions_target_idx ON site.platform_mod_actions USING btree (target_id, created_at DESC);

--
-- Name: player_source_snapshots_recorded_at_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX player_source_snapshots_recorded_at_idx ON site.player_source_snapshots USING btree (recorded_at);

--
-- Name: presence_last_beat_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX presence_last_beat_idx ON site.presence USING btree (last_beat DESC);

--
-- Name: radio_likes_track_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX radio_likes_track_idx ON site.radio_likes USING btree (track_id);

--
-- Name: reports_pending_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX reports_pending_idx ON site.reports USING btree (created_at DESC) WHERE (status = 'pending'::text);

--
-- Name: rss_items_published_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX rss_items_published_idx ON site.rss_items USING btree (published_at DESC NULLS LAST);

--
-- Name: sticker_boosts_message_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX sticker_boosts_message_idx ON site.sticker_boosts USING btree (original_message_id);

--
-- Name: stripe_customers_viewer; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX stripe_customers_viewer ON site.stripe_customers USING btree (matrix_id);

--
-- Name: subscription_claims_matrix_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX subscription_claims_matrix_idx ON site.subscription_claims USING btree (matrix_id);

--
-- Name: subscription_events_body_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX subscription_events_body_idx ON site.subscription_events USING btree (received_at) WHERE (body IS NOT NULL);

--
-- Name: subscription_events_inbox_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX subscription_events_inbox_idx ON site.subscription_events USING btree (received_at) WHERE (applied_at IS NULL);

--
-- Name: subscription_events_record_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX subscription_events_record_idx ON site.subscription_events USING btree (provider, external_id) WHERE (external_id IS NOT NULL);

--
-- Name: subscription_intents_matrix_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX subscription_intents_matrix_idx ON site.subscription_intents USING btree (matrix_id);

--
-- Name: subscription_payments_record_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX subscription_payments_record_idx ON site.subscription_payments USING btree (record_id);

--
-- Name: subscription_records_access_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX subscription_records_access_idx ON site.subscription_records USING btree (provider, access_until) WHERE (status = ANY (ARRAY['active'::text, 'past_due'::text]));

--
-- Name: subscription_records_matrix_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX subscription_records_matrix_idx ON site.subscription_records USING btree (matrix_id) WHERE (matrix_id IS NOT NULL);

--
-- Name: subscriptions_stripe_customer_id_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX subscriptions_stripe_customer_id_idx ON site.subscriptions USING btree (stripe_customer_id);

--
-- Name: support_tickets_status_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX support_tickets_status_idx ON site.support_tickets USING btree (status, created_at DESC);

--
-- Name: user_sessions_matrix_id_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX user_sessions_matrix_id_idx ON site.user_sessions USING btree (matrix_id);

--
-- Name: user_slow_mode_active_idx; Type: INDEX; Schema: site; Owner: -
--

CREATE INDEX user_slow_mode_active_idx ON site.user_slow_mode USING btree (expires_at);

--
-- Name: bot_memory_kind_created; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX bot_memory_kind_created ON stream.bot_memory USING btree (kind, created_at DESC);

--
-- Name: bot_memory_lore_slot; Type: INDEX; Schema: stream; Owner: -
--

CREATE UNIQUE INDEX bot_memory_lore_slot ON stream.bot_memory USING btree (slot) WHERE (kind = 'lore'::text);

--
-- Name: bot_trace_ts_idx; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX bot_trace_ts_idx ON stream.bot_trace USING btree (ts DESC);

--
-- Name: chat_log_user_time; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX chat_log_user_time ON stream.chat_log USING btree (user_id, created_at DESC);

--
-- Name: idx_bot_responses_created_at; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX idx_bot_responses_created_at ON stream.bot_responses USING btree (created_at DESC);

--
-- Name: idx_chat_log_created_at; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX idx_chat_log_created_at ON stream.chat_log USING btree (created_at DESC);

--
-- Name: idx_chat_log_handle_platform; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX idx_chat_log_handle_platform ON stream.chat_log USING btree (lower(username), lower(platform), created_at DESC);

--
-- Name: idx_chat_log_message_trgm; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX idx_chat_log_message_trgm ON stream.chat_log USING gin (message public.gin_trgm_ops);

--
-- Name: idx_chat_log_platform_msg; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX idx_chat_log_platform_msg ON stream.chat_log USING btree (platform, platform_msg_id) WHERE (platform_msg_id IS NOT NULL);

--
-- Name: idx_chat_log_stream_id; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX idx_chat_log_stream_id ON stream.chat_log USING btree (stream_id);

--
-- Name: idx_chat_log_user_id; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX idx_chat_log_user_id ON stream.chat_log USING btree (user_id);

--
-- Name: idx_message_embeddings_created_at; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX idx_message_embeddings_created_at ON stream.message_embeddings USING btree (created_at);

--
-- Name: idx_message_embeddings_username_lower; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX idx_message_embeddings_username_lower ON stream.message_embeddings USING btree (lower(username));

--
-- Name: idx_support_events_user_id; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX idx_support_events_user_id ON stream.support_events USING btree (user_id);

--
-- Name: message_embeddings_hnsw; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX message_embeddings_hnsw ON stream.message_embeddings USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');

--
-- Name: polls_active_idx; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX polls_active_idx ON stream.polls USING btree (status) WHERE (status = 'active'::text);

--
-- Name: radio_tracks_dj_idx; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX radio_tracks_dj_idx ON stream.radio_tracks USING btree (segment_type) WHERE ((kind = 'dj'::text) AND enabled);

--
-- Name: radio_tracks_intro_idx; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX radio_tracks_intro_idx ON stream.radio_tracks USING btree (intro_track_id) WHERE (intro_track_id IS NOT NULL);

--
-- Name: radio_tracks_song_idx; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX radio_tracks_song_idx ON stream.radio_tracks USING btree (genre) WHERE ((kind = 'song'::text) AND enabled);

--
-- Name: support_events_event_id_key; Type: INDEX; Schema: stream; Owner: -
--

CREATE UNIQUE INDEX support_events_event_id_key ON stream.support_events USING btree (event_id) WHERE (event_id IS NOT NULL);

--
-- Name: support_events_reverses_id; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX support_events_reverses_id ON stream.support_events USING btree (reverses_id) WHERE (reverses_id IS NOT NULL);

--
-- Name: unpriced_support_event_id; Type: INDEX; Schema: stream; Owner: -
--

CREATE UNIQUE INDEX unpriced_support_event_id ON stream.unpriced_support USING btree (event_id) WHERE (event_id IS NOT NULL);

--
-- Name: viewer_snapshots_recorded_at_idx; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX viewer_snapshots_recorded_at_idx ON stream.viewer_snapshots USING btree (recorded_at);

--
-- Name: viewer_snapshots_stream_id_idx; Type: INDEX; Schema: stream; Owner: -
--

CREATE INDEX viewer_snapshots_stream_id_idx ON stream.viewer_snapshots USING btree (stream_id);

--
-- Name: accounts accounts_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.accounts
    ADD CONSTRAINT accounts_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: automod_held automod_held_site_msg_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.automod_held
    ADD CONSTRAINT automod_held_site_msg_id_fkey FOREIGN KEY (site_msg_id) REFERENCES site.chat_messages(id) ON DELETE SET NULL;

--
-- Name: badge_unlocks badge_unlocks_badge_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.badge_unlocks
    ADD CONSTRAINT badge_unlocks_badge_id_fkey FOREIGN KEY (badge_id) REFERENCES site.badges(id) ON DELETE CASCADE;

--
-- Name: bans bans_banned_by_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.bans
    ADD CONSTRAINT bans_banned_by_fkey FOREIGN KEY (banned_by) REFERENCES site.users(matrix_id);

--
-- Name: bans bans_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.bans
    ADD CONSTRAINT bans_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: chat_message_platform_copies chat_message_platform_copies_site_msg_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.chat_message_platform_copies
    ADD CONSTRAINT chat_message_platform_copies_site_msg_id_fkey FOREIGN KEY (site_msg_id) REFERENCES site.chat_messages(id) ON DELETE CASCADE;

--
-- Name: chat_messages chat_messages_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.chat_messages
    ADD CONSTRAINT chat_messages_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: chat_messages chat_messages_reply_to_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.chat_messages
    ADD CONSTRAINT chat_messages_reply_to_id_fkey FOREIGN KEY (reply_to_id) REFERENCES site.chat_messages(id);

--
-- Name: coin_earn_stream coin_earn_stream_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.coin_earn_stream
    ADD CONSTRAINT coin_earn_stream_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: coin_earn_upvotes coin_earn_upvotes_recipient_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.coin_earn_upvotes
    ADD CONSTRAINT coin_earn_upvotes_recipient_fkey FOREIGN KEY (recipient) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: community_embeds community_embeds_added_by_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.community_embeds
    ADD CONSTRAINT community_embeds_added_by_fkey FOREIGN KEY (added_by) REFERENCES site.users(matrix_id) ON DELETE SET NULL;

--
-- Name: donations donations_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.donations
    ADD CONSTRAINT donations_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE SET NULL;

--
-- Name: forum_pins forum_pins_pinned_by_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.forum_pins
    ADD CONSTRAINT forum_pins_pinned_by_fkey FOREIGN KEY (pinned_by) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: forum_votes forum_votes_voter_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.forum_votes
    ADD CONSTRAINT forum_votes_voter_matrix_id_fkey FOREIGN KEY (voter_matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: gift_pending gift_pending_claimed_by_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.gift_pending
    ADD CONSTRAINT gift_pending_claimed_by_fkey FOREIGN KEY (claimed_by) REFERENCES site.users(matrix_id) ON DELETE SET NULL;

--
-- Name: gift_pending gift_pending_gifter_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.gift_pending
    ADD CONSTRAINT gift_pending_gifter_matrix_id_fkey FOREIGN KEY (gifter_matrix_id) REFERENCES site.users(matrix_id) ON DELETE SET NULL;

--
-- Name: gift_subscriptions gift_subscriptions_gifter_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.gift_subscriptions
    ADD CONSTRAINT gift_subscriptions_gifter_matrix_id_fkey FOREIGN KEY (gifter_matrix_id) REFERENCES site.users(matrix_id) ON DELETE SET NULL;

--
-- Name: gift_subscriptions gift_subscriptions_recipient_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.gift_subscriptions
    ADD CONSTRAINT gift_subscriptions_recipient_matrix_id_fkey FOREIGN KEY (recipient_matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: memory_opt_outs memory_opt_outs_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.memory_opt_outs
    ADD CONSTRAINT memory_opt_outs_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: message_votes message_votes_voter_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.message_votes
    ADD CONSTRAINT message_votes_voter_matrix_id_fkey FOREIGN KEY (voter_matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: payment_events payment_events_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.payment_events
    ADD CONSTRAINT payment_events_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE SET NULL;

--
-- Name: platform_links platform_links_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.platform_links
    ADD CONSTRAINT platform_links_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: presence presence_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.presence
    ADD CONSTRAINT presence_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: radio_likes radio_likes_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.radio_likes
    ADD CONSTRAINT radio_likes_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: reports reports_reported_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.reports
    ADD CONSTRAINT reports_reported_id_fkey FOREIGN KEY (reported_id) REFERENCES site.users(matrix_id);

--
-- Name: reports reports_reporter_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.reports
    ADD CONSTRAINT reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES site.users(matrix_id);

--
-- Name: rss_items rss_items_feed_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.rss_items
    ADD CONSTRAINT rss_items_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES site.rss_feeds(id) ON DELETE CASCADE;

--
-- Name: signup_answers signup_answers_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.signup_answers
    ADD CONSTRAINT signup_answers_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: sticker_boosts sticker_boosts_booster_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.sticker_boosts
    ADD CONSTRAINT sticker_boosts_booster_matrix_id_fkey FOREIGN KEY (booster_matrix_id) REFERENCES site.users(matrix_id);

--
-- Name: sticker_boosts sticker_boosts_original_message_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.sticker_boosts
    ADD CONSTRAINT sticker_boosts_original_message_id_fkey FOREIGN KEY (original_message_id) REFERENCES site.chat_messages(id) ON DELETE CASCADE;

--
-- Name: subscription_accounts subscription_accounts_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.subscription_accounts
    ADD CONSTRAINT subscription_accounts_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: subscription_claims subscription_claims_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.subscription_claims
    ADD CONSTRAINT subscription_claims_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: subscription_intents subscription_intents_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.subscription_intents
    ADD CONSTRAINT subscription_intents_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: subscription_payments subscription_payments_record_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.subscription_payments
    ADD CONSTRAINT subscription_payments_record_id_fkey FOREIGN KEY (record_id) REFERENCES site.subscription_records(id) ON DELETE CASCADE;

--
-- Name: subscription_records subscription_records_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.subscription_records
    ADD CONSTRAINT subscription_records_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: subscriptions subscriptions_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.subscriptions
    ADD CONSTRAINT subscriptions_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: support_tickets support_tickets_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.support_tickets
    ADD CONSTRAINT support_tickets_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: term_files term_files_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.term_files
    ADD CONSTRAINT term_files_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.term_accounts(matrix_id) ON DELETE CASCADE;

--
-- Name: term_snapshots term_snapshots_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.term_snapshots
    ADD CONSTRAINT term_snapshots_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.term_accounts(matrix_id) ON DELETE CASCADE;

--
-- Name: user_nudges user_nudges_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.user_nudges
    ADD CONSTRAINT user_nudges_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: user_sessions user_sessions_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.user_sessions
    ADD CONSTRAINT user_sessions_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: user_settings user_settings_matrix_id_fkey; Type: FK CONSTRAINT; Schema: site; Owner: -
--

ALTER TABLE ONLY site.user_settings
    ADD CONSTRAINT user_settings_matrix_id_fkey FOREIGN KEY (matrix_id) REFERENCES site.users(matrix_id) ON DELETE CASCADE;

--
-- Name: bot_impressions bot_impressions_user_id_fkey; Type: FK CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.bot_impressions
    ADD CONSTRAINT bot_impressions_user_id_fkey FOREIGN KEY (user_id) REFERENCES stream.users(id) ON DELETE CASCADE;

--
-- Name: chat_log chat_log_stream_id_fkey; Type: FK CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.chat_log
    ADD CONSTRAINT chat_log_stream_id_fkey FOREIGN KEY (stream_id) REFERENCES stream.sessions(stream_id);

--
-- Name: chat_log chat_log_user_id_fkey; Type: FK CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.chat_log
    ADD CONSTRAINT chat_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES stream.users(id);

--
-- Name: links links_canonical_fkey; Type: FK CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.links
    ADD CONSTRAINT links_canonical_fkey FOREIGN KEY (canonical) REFERENCES stream.users(id);

--
-- Name: nameidx nameidx_canonical_fkey; Type: FK CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.nameidx
    ADD CONSTRAINT nameidx_canonical_fkey FOREIGN KEY (canonical) REFERENCES stream.users(id);

--
-- Name: poll_votes poll_votes_poll_id_fkey; Type: FK CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.poll_votes
    ADD CONSTRAINT poll_votes_poll_id_fkey FOREIGN KEY (poll_id) REFERENCES stream.polls(id) ON DELETE CASCADE;

--
-- Name: radio_tracks radio_tracks_intro_track_id_fkey; Type: FK CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.radio_tracks
    ADD CONSTRAINT radio_tracks_intro_track_id_fkey FOREIGN KEY (intro_track_id) REFERENCES stream.radio_tracks(id) ON DELETE SET NULL;

--
-- Name: support_events support_events_reverses_id_fkey; Type: FK CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.support_events
    ADD CONSTRAINT support_events_reverses_id_fkey FOREIGN KEY (reverses_id) REFERENCES stream.support_events(id);

--
-- Name: support_events support_events_stream_id_fkey; Type: FK CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.support_events
    ADD CONSTRAINT support_events_stream_id_fkey FOREIGN KEY (stream_id) REFERENCES stream.sessions(stream_id);

--
-- Name: support_events support_events_user_id_fkey; Type: FK CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.support_events
    ADD CONSTRAINT support_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES stream.users(id);

--
-- Name: user_stats user_stats_user_id_fkey; Type: FK CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.user_stats
    ADD CONSTRAINT user_stats_user_id_fkey FOREIGN KEY (user_id) REFERENCES stream.users(id);

--
-- Name: viewer_snapshots viewer_snapshots_stream_id_fkey; Type: FK CONSTRAINT; Schema: stream; Owner: -
--

ALTER TABLE ONLY stream.viewer_snapshots
    ADD CONSTRAINT viewer_snapshots_stream_id_fkey FOREIGN KEY (stream_id) REFERENCES stream.sessions(stream_id);

--
-- PostgreSQL database dump complete
--

--
-- schema_migrations: every version the chain had applied, marked as arriving with the baseline.
--

-- baseline:versions
INSERT INTO public.schema_migrations (version, note) VALUES
  (2, 'baseline'),
  (3, 'baseline'),
  (4, 'baseline'),
  (5, 'baseline'),
  (6, 'baseline'),
  (7, 'baseline'),
  (8, 'baseline'),
  (9, 'baseline'),
  (10, 'baseline'),
  (11, 'baseline'),
  (12, 'baseline'),
  (13, 'baseline'),
  (14, 'baseline'),
  (15, 'baseline'),
  (16, 'baseline'),
  (17, 'baseline'),
  (18, 'baseline'),
  (19, 'baseline'),
  (20, 'baseline'),
  (21, 'baseline'),
  (22, 'baseline'),
  (23, 'baseline'),
  (24, 'baseline'),
  (25, 'baseline'),
  (26, 'baseline'),
  (27, 'baseline'),
  (28, 'baseline'),
  (29, 'baseline'),
  (30, 'baseline'),
  (31, 'baseline'),
  (32, 'baseline'),
  (33, 'baseline'),
  (34, 'baseline'),
  (35, 'baseline'),
  (36, 'baseline'),
  (37, 'baseline'),
  (38, 'baseline'),
  (39, 'baseline'),
  (40, 'baseline'),
  (41, 'baseline'),
  (42, 'baseline'),
  (43, 'baseline'),
  (44, 'baseline'),
  (45, 'baseline'),
  (46, 'baseline'),
  (47, 'baseline'),
  (48, 'baseline'),
  (49, 'baseline'),
  (50, 'baseline'),
  (51, 'baseline'),
  (52, 'baseline'),
  (53, 'baseline'),
  (54, 'baseline'),
  (55, 'baseline'),
  (56, 'baseline'),
  (57, 'baseline'),
  (58, 'baseline'),
  (59, 'baseline'),
  (60, 'baseline'),
  (61, 'baseline'),
  (62, 'baseline'),
  (63, 'baseline'),
  (64, 'baseline'),
  (65, 'baseline'),
  (66, 'baseline'),
  (67, 'baseline'),
  (68, 'baseline'),
  (69, 'baseline'),
  (70, 'baseline'),
  (71, 'baseline'),
  (72, 'baseline'),
  (73, 'baseline'),
  (74, 'baseline'),
  (75, 'baseline'),
  (76, 'baseline'),
  (77, 'baseline'),
  (78, 'baseline'),
  (79, 'baseline'),
  (80, 'baseline'),
  (81, 'baseline'),
  (82, 'baseline'),
  (83, 'baseline'),
  (84, 'baseline'),
  (85, 'baseline'),
  (86, 'baseline'),
  (87, 'baseline'),
  (88, 'baseline'),
  (89, 'baseline'),
  (90, 'baseline'),
  (91, 'baseline'),
  (92, 'baseline'),
  (93, 'baseline'),
  (94, 'baseline'),
  (95, 'baseline'),
  (96, 'baseline'),
  (97, 'baseline'),
  (98, 'baseline'),
  (99, 'baseline'),
  (100, 'baseline'),
  (101, 'baseline'),
  (102, 'baseline'),
  (103, 'baseline'),
  (104, 'baseline'),
  (105, 'baseline'),
  (106, 'baseline'),
  (107, 'baseline'),
  (108, 'baseline'),
  (109, 'baseline'),
  (110, 'baseline'),
  (111, 'baseline'),
  (112, 'baseline'),
  (113, 'baseline'),
  (114, 'baseline'),
  (115, 'baseline'),
  (116, 'baseline'),
  (117, 'baseline'),
  (118, 'baseline'),
  (119, 'baseline'),
  (120, 'baseline'),
  (121, 'baseline'),
  (122, 'baseline'),
  (123, 'baseline'),
  (124, 'baseline'),
  (125, 'baseline'),
  (126, 'baseline'),
  (127, 'baseline'),
  (128, 'baseline'),
  (129, 'baseline'),
  (130, 'baseline'),
  (131, 'baseline'),
  (132, 'baseline'),
  (133, 'baseline'),
  (134, 'baseline'),
  (135, 'baseline'),
  (136, 'baseline'),
  (137, 'baseline'),
  (138, 'baseline'),
  (139, 'baseline'),
  (140, 'baseline'),
  (141, 'baseline'),
  (142, 'baseline'),
  (143, 'baseline'),
  (144, 'baseline'),
  (145, 'baseline'),
  (146, 'baseline'),
  (147, 'baseline'),
  (148, 'baseline'),
  (149, 'baseline'),
  (150, 'baseline'),
  (151, 'baseline'),
  (152, 'baseline'),
  (153, 'baseline'),
  (154, 'baseline'),
  (155, 'baseline'),
  (156, 'baseline'),
  (157, 'baseline'),
  (158, 'baseline'),
  (159, 'baseline'),
  (160, 'baseline'),
  (161, 'baseline'),
  (162, 'baseline'),
  (163, 'baseline'),
  (164, 'baseline')
ON CONFLICT (version) DO NOTHING;
-- baseline:end

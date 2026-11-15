CREATE TABLE IF NOT EXISTS promo_codes (
    code            text PRIMARY KEY,
    kind            text NOT NULL CHECK (kind IN ('percent', 'fixed')),
    value           integer NOT NULL CHECK (value > 0),
    expires_at_ms   bigint NOT NULL,
    max_uses        integer NOT NULL CHECK (max_uses >= 0),
    used_count      integer NOT NULL DEFAULT 0,
    min_order_cents integer
);

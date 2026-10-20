-- v157: site.lockdown.signups_disabled_at — when the "New signups" lever was last switched ON.
--
-- The homeserver sign-up reconcile (web app/lib/lockdownRegistration.ts) closes sign-up once per
-- lockdown and then keeps an admin's later change. "This lockdown" needs a boundary owned by the
-- lever itself: it was read from the mod log (an audit trail written in its own statement, which
-- can be missing), so a missing log row could skip the close and leave the homeserver open while
-- the screen said closed. Set by the same UPDATE that switches the lever on; NULL when it is off.

BEGIN;

ALTER TABLE site.lockdown ADD COLUMN IF NOT EXISTS signups_disabled_at timestamptz;

-- A lever on today: the best-known start is the row's last change.
UPDATE site.lockdown SET signups_disabled_at = updated_at
 WHERE signups_disabled AND signups_disabled_at IS NULL;

INSERT INTO public.schema_migrations (version, note)
VALUES (157, 'site.lockdown.signups_disabled_at: when the signups lever was switched on (homeserver sign-up reconcile boundary)')
ON CONFLICT DO NOTHING;

COMMIT;

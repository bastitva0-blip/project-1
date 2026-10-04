-- ══════════════════════════════════════════════════════════
--  BURGER POINT — Phase 8: Owner background order alerts
--  Run in Supabase SQL Editor (after phase7_web_push.sql).
-- ══════════════════════════════════════════════════════════

-- 1. The app + edge function use a `role` column ('customer' | 'rider' | 'admin'),
--    but phase 7 only created `user_type`. Add it so subscriptions actually save.
ALTER TABLE public.push_subscriptions ADD COLUMN IF NOT EXISTS role text;
UPDATE public.push_subscriptions SET role = user_type WHERE role IS NULL;
ALTER TABLE public.push_subscriptions ALTER COLUMN role SET DEFAULT 'customer';
CREATE INDEX IF NOT EXISTS push_subscriptions_role_idx ON public.push_subscriptions(role);

-- 2. The admin is a logged-in (authenticated) user; phase 7 only allowed `anon`.
DROP POLICY IF EXISTS "auth insert push sub" ON public.push_subscriptions;
DROP POLICY IF EXISTS "auth update push sub" ON public.push_subscriptions;
DROP POLICY IF EXISTS "auth select push sub" ON public.push_subscriptions;
CREATE POLICY "auth insert push sub" ON public.push_subscriptions FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth update push sub" ON public.push_subscriptions FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth select push sub" ON public.push_subscriptions FOR SELECT TO authenticated USING (true);

-- 3. OPTIONAL — nag every minute until the order is accepted.
--    First: Dashboard → Database → Extensions → enable `pg_cron` and `pg_net`.
--    Then replace the two placeholders and uncomment.
--
-- SELECT cron.schedule(
--   'bp-order-reminder', '* * * * *',
--   $$ SELECT net.http_post(
--        url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/send-push',
--        headers := jsonb_build_object(
--          'Content-Type',     'application/json',
--          'Authorization',    'Bearer YOUR-ANON-KEY',
--          'x-webhook-secret', 'YOUR-WEBHOOK-SECRET'),
--        body    := '{"mode":"reminder"}'::jsonb
--      ); $$
-- );
-- To stop it later:  SELECT cron.unschedule('bp-order-reminder');

SELECT role, COUNT(*) FROM public.push_subscriptions GROUP BY role;

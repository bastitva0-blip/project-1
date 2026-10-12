-- ══════════════════════════════════════════════════════════
--  BURGER POINT — Phase 10: 4 manual banner slides (label + featured item each)
--  Run in Supabase → SQL Editor. Safe to re-run.
--  Slide 1 keeps using the existing special_label / special_item_id columns.
-- ══════════════════════════════════════════════════════════
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS special_label_2   text;
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS special_item_id_2 text;
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS special_label_3   text;
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS special_item_id_3 text;
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS special_label_4   text;
ALTER TABLE public.business_settings ADD COLUMN IF NOT EXISTS special_item_id_4 text;

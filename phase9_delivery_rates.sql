-- ══════════════════════════════════════════════════════════
--  BURGER POINT — Phase 9: Two-rate menu (dine-in/takeaway vs delivery)
--  Run in Supabase → SQL Editor. Safe to re-run.
-- ══════════════════════════════════════════════════════════

-- Rate 2 (delivery). NULL = same as the normal price.
-- (Per-size delivery rates live inside the existing `variants` JSON as variants[].delivery_price.)
ALTER TABLE public.menu_items ADD COLUMN IF NOT EXISTS delivery_price numeric;

-- Columns the admin order list now reads so printed bills include delivery/packing/GST
-- (all three already exist from earlier phases; these are no-ops if so)
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_fee         numeric DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS packing_charge       numeric DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS gst_amount           numeric DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_distance_km numeric;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS razorpay_payment_id  text;

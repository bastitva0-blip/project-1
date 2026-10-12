// ─────────────────────────────────────────────────────────
//  Delivery distance + fee calculation.
//
//  Distance is straight-line (haversine), not true road distance —
//  a real road-routing figure needs a paid API (Google Distance
//  Matrix, OSRM, etc.) with a server-side key. Haversine is the
//  standard lightweight approximation used by most small delivery
//  apps for tiered pricing; swap `haversineKm` for a routing-API
//  call later if you get a maps API key.
// ─────────────────────────────────────────────────────────

export function haversineKm(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(v => v == null || Number.isNaN(v))) return null;
  const R = 6371; // km
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Returns { deliverable, distanceKm, fee, reason, freeDelivery, etaMinutes }
 * settings = row from business_settings table
 */
export function calculateDelivery(distanceKm, subtotal, settings) {
  const {
    delivery_radius_km = 8,
    base_delivery_charge = 25,
    base_distance_km = 2,
    per_km_charge = 8,
    free_delivery_above = 499,
    avg_delivery_speed_kmph = 25,
  } = settings || {};

  const freeDelivery = free_delivery_above > 0 && subtotal >= free_delivery_above;

  // Distance not known yet (location missing / routing still loading / failed).
  // NEVER return a ₹0 fee here — charge the minimum (base) delivery fee as a
  // provisional amount so a delivery order can't slip through undercharged.
  if (distanceKm == null || Number.isNaN(distanceKm)) {
    return {
      deliverable: null, distanceKm: null,
      fee: freeDelivery ? 0 : Number(base_delivery_charge) || 0,
      reason: null, freeDelivery, etaMinutes: null, provisional: true,
    };
  }

  if (distanceKm > delivery_radius_km) {
    return {
      deliverable: false,
      distanceKm,
      fee: 0,
      reason: `Sorry, you're ${distanceKm.toFixed(1)} km away — we currently deliver up to ${delivery_radius_km} km. Try Takeaway instead, or check back once you're closer!`,
      freeDelivery: false,
      etaMinutes: null,
    };
  }

  let fee = base_delivery_charge;
  if (distanceKm > base_distance_km) {
    fee += Math.ceil(distanceKm - base_distance_km) * per_km_charge;
  }
  if (freeDelivery) fee = 0;

  const etaMinutes = Math.max(15, Math.round((distanceKm / Math.max(avg_delivery_speed_kmph, 1)) * 60) + 15); // + prep time

  return { deliverable: true, distanceKm, fee, reason: null, freeDelivery, etaMinutes, provisional: false };
}

/**
 * Road distance (OSRM) with a haversine ×1.3 fallback. Never returns NaN.
 * Resolves { km, approx } — km is null only if coordinates are missing.
 */
export async function resolveRoadDistanceKm(rLat, rLng, lat, lng, timeoutMs = 5000) {
  if ([rLat, rLng, lat, lng].some(v => v == null || Number.isNaN(Number(v)))) return { km: null, approx: false };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${rLng},${rLat};${lng},${lat}?overview=false`,
      { signal: ctrl.signal }
    );
    clearTimeout(t);
    const d = await r.json();
    const km = Number(d?.routes?.[0]?.distance) / 1000;
    if (Number.isFinite(km) && km > 0) return { km, approx: false };
  } catch { /* fall through to straight-line estimate */ }
  const straight = haversineKm(rLat, rLng, lat, lng);
  return { km: straight != null ? straight * 1.3 : null, approx: true };
}

// ─────────────────────────────────────────────────────────
//  Two-rate menu: rate 1 = dine-in / takeaway, rate 2 = delivery.
//  menu_items.delivery_price (and variants[].delivery_price) are optional —
//  blank means "same as rate 1".
// ─────────────────────────────────────────────────────────
const hasRate = (v) => v !== null && v !== undefined && v !== "" && !Number.isNaN(Number(v));

/** Returns the item with price/variant prices swapped to the delivery rate when orderType is delivery. */
export function applyRateForOrderType(item, orderType) {
  if (!item || orderType !== "delivery") return item;
  const out = { ...item };
  if (hasRate(item.delivery_price)) out.price = Number(item.delivery_price);
  if (Array.isArray(item.variants) && item.variants.length) {
    out.variants = item.variants.map(v => hasRate(v.delivery_price) ? { ...v, price: Number(v.delivery_price) } : v);
    // keep headline "from" price in step with the cheapest delivery size
    if (!hasRate(item.delivery_price)) {
      const prices = out.variants.map(v => Number(v.price)).filter(n => n > 0);
      if (prices.length && out.variants.some((v, i) => v.price !== item.variants[i].price)) out.price = Math.min(...prices);
    }
  }
  return out;
}

/** Rate shown for one admin POS line: delivery rate when ordering for delivery, else normal rate. */
export function posRate(item, orderType, variantPrice = null) {
  const base = variantPrice != null ? variantPrice : item.price;
  if (orderType === "delivery" && variantPrice == null && hasRate(item.delivery_price)) return Number(item.delivery_price);
  return Number(base || 0);
}

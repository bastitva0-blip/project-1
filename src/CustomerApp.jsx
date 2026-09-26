import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Search, X, Plus, Minus, ArrowLeft, ShoppingCart, MapPin, Phone,
  CheckCircle, User, Navigation, CreditCard, Smartphone, Download,
  Heart, Clock, Star, Share2, History, RefreshCw, Wifi, WifiOff,
  Bike, Shield, Trash2, Tag, ThumbsUp, ThumbsDown, CalendarDays,
} from "lucide-react";

import {
  useToast, MenuSkeleton, CategoryBarSkeleton, BestsellerSkeleton,
  CartItemSkeleton, useSavedAddresses, SavedAddressPicker,
} from "./ui.jsx";
import { supabase } from "./supabase.js";
import {
  CATEGORIES, DEFAULT_MENU, ALL_ITEMS, SUPABASE_READY,
  clearTableSession, getTrackerSteps, STATUS_CFG, isOrderActive,
  REVIEW_URL, WHATSAPP, INSTAGRAM,
} from "./constants.js";
import { haversineKm, calculateDelivery } from "./deliveryUtils.js";
import { useBusinessSettings } from "./useBusinessSettings.js";
import { lazy, Suspense } from "react";
const DeliveryTracker = lazy(() => import("./DeliveryTracker.jsx"));

// ── helpers ───────────────────────────────────────────────
function useAppUpdateAvailable() {
  const [available, setAvailable] = useState(typeof window !== "undefined" && !!window.__bpUpdateAvailable);
  useEffect(() => {
    if (window.__bpUpdateAvailable) { setAvailable(true); return; }
    const handler = () => setAvailable(true);
    window.addEventListener("bp:update-available", handler);
    return () => window.removeEventListener("bp:update-available", handler);
  }, []);
  return available;
}

const LS_FAVS         = "bp_favs";

// ── Safe localStorage helpers (crash-safe for private/incognito browsing) ──
const lsGet = (key, fallback = null) => { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; } };
const lsSet = (key, val) => { try { localStorage.setItem(key, val); } catch {} };
const lsRemove = (key) => { try { localStorage.removeItem(key); } catch {} };
const LS_HISTORY      = "bp_order_history";
const SS_ORDER        = "bp_placed_order";
const LS_ACTIVE_ORDER = "bp_active_order";   // persists across browser close
const LS_BESTSELLERS  = "bp_bestsellers";    // cached bestseller IDs
const LS_CUSTOMER     = "bp_customer";       // saved name + phone
const LS_RESERVATION  = "bp_reservation";   // active reservation (persists across sessions)
const LS_SESSION      = "bp_session_id";     // stable UUID per browser — scopes order reads

// Returns a stable UUID for this browser. Generated once, persisted in
// localStorage so the same customer can track their order across page reloads.
const getSessionId = () => {
  let s = lsGet(LS_SESSION);
  if (!s) { s = crypto.randomUUID(); lsSet(LS_SESSION, s); }
  return s;
};
const ACTIVE_STATUSES = new Set(["pending", "accepted", "ready", "dispatched"]);
const SS_WAIT    = "bp_wait_times";

const saveHistory = (order) => {
  try {
    const list = JSON.parse(lsGet(LS_HISTORY, "[]"));
    list.unshift(order);
    lsSet(LS_HISTORY, JSON.stringify(list.slice(0, 12)));
  } catch {}
};

// ── SHARED ITEM THUMBNAIL ─────────────────────────────────
export function ItemThumb({ item, className = "w-16 h-16", children }) {
  const [err, setErr] = useState(false);
  const cat = CATEGORIES.find(c => c.id === item.category);
  const emoji = item.emoji || cat?.emoji || "🍽️";
  return (
    <div className={`${className} rounded-2xl flex-shrink-0 overflow-hidden bg-orange-50 relative`}>
      {!err && item.img
        ? <img src={item.img} alt={item.name} loading="lazy" className="w-full h-full object-cover" onError={() => setErr(true)} />
        : <div className="w-full h-full flex items-center justify-center text-2xl bg-gradient-to-br from-orange-100 to-amber-100">{emoji}</div>
      }
      {children}
    </div>
  );
}

// ── BESTSELLER BADGE ──────────────────────────────────────
function BestsellerBadge() {
  return (
    <span className="inline-flex items-center gap-0.5 bg-gradient-to-r from-orange-500 to-red-500 text-white text-[9px] font-black px-2 py-0.5 rounded-full shadow-sm tracking-wide">
      🔥 Bestseller
    </span>
  );
}

// ── ITEM CARD ─────────────────────────────────────────────
function ItemCard({ item, cartQty, onAdd, onQtyChange, isFav, onToggleFav, isBestseller }) {
  const unavail = item.is_available === false;
  const [popping, setPopping] = useState(false);
  const handleAdd = () => {
    setPopping(true);
    setTimeout(() => setPopping(false), 200);
    onAdd(item);
  };
  return (
    <div className={`flex gap-3 py-4 border-b border-stone-100 last:border-0 ${unavail ? "opacity-50" : ""}`}>
      <ItemThumb item={item} className="w-20 h-20">
        <span className="absolute top-1 right-1 w-4 h-4 border-2 border-green-600 rounded-sm bg-white flex items-center justify-center">
          <span className="w-2 h-2 rounded-full bg-green-600" />
        </span>
      </ItemThumb>
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-1">
          <p className="text-sm font-bold text-stone-800 leading-tight flex-1">{item.name}</p>
          <button onClick={() => onToggleFav(item.id)} className="p-0.5 flex-shrink-0">
            <Heart size={14} className={isFav ? "fill-red-500 text-red-500" : "text-stone-300"} />
          </button>
        </div>
        {isBestseller && <div className="mt-1"><BestsellerBadge /></div>}
        {item.description && <p className="text-[11px] text-stone-400 mt-0.5 leading-snug line-clamp-2">{item.description}</p>}
        <div className="flex items-center gap-1 mt-1">
          <p className="text-sm font-black text-stone-800">₹{item.price}</p>
          {item.variants && <span className="text-xs text-stone-400 ml-1">onwards</span>}
        </div>
        {item.variants && (
          <div className="flex gap-1 mt-1 flex-wrap">
            {item.variants.map((v, i) => (
              <span key={i} className="text-[10px] bg-stone-100 text-stone-500 px-1.5 py-0.5 rounded-md font-medium">{v.label} ₹{v.price}</span>
            ))}
          </div>
        )}
        {item.addons?.length > 0 && (
          <p className="text-[10px] text-orange-500 mt-1">+ Customisable</p>
        )}
      </div>
      {unavail ? (
        <span className="self-center text-[10px] bg-stone-100 text-stone-400 font-bold px-2 py-1 rounded-xl flex-shrink-0">Sold Out</span>
      ) : cartQty > 0 && !item.variants ? (
        <div className="self-center flex items-center gap-1 bg-orange-500 rounded-xl px-2 py-1.5 flex-shrink-0 shadow-md">
          <button onClick={() => onQtyChange(cartQty - 1)} className="w-7 h-7 flex items-center justify-center"><Minus size={12} className="text-white" /></button>
          <span className="text-xs font-black text-white w-4 text-center">{cartQty}</span>
          <button onClick={() => onQtyChange(cartQty + 1)} className="w-7 h-7 flex items-center justify-center"><Plus size={12} className="text-white" /></button>
        </div>
      ) : (
        <button onClick={handleAdd}
          className={`self-center flex items-center gap-1 bg-white border-2 border-orange-400 text-orange-600 px-3 py-1.5 rounded-xl text-xs font-bold shadow-sm active:scale-95 transition-all hover:bg-orange-500 hover:text-white flex-shrink-0 relative ${popping ? "add-pop" : ""}`}>
          <Plus size={12} /> ADD
          {cartQty > 0 && item.variants && (
            <span className="absolute -top-2 -right-2 bg-orange-500 text-white text-[9px] rounded-full w-4 h-4 flex items-center justify-center">{cartQty}</span>
          )}
        </button>
      )}
    </div>
  );
}

// ── ITEM MODAL (variant + addons + spice) ─────────────────
function ItemModal({ item, onClose, onAdd }) {
  const [selVariant, setSelVariant] = useState(0);
  const [qty, setQty]               = useState(1);
  const [selAddons, setSelAddons]   = useState([]);  // ids of toggled addons
  const [spice, setSpice]           = useState("Medium");

  const hasVariants = item.variants?.length > 0;
  const addons = item.addons || [];
  const spiceAddon = addons.find(a => a.type === "select" && a.id === "spice");
  const toggleAddons = addons.filter(a => a.type !== "select" || a.id !== "spice");

  const chosen      = hasVariants ? item.variants[selVariant] : null;
  const basePrice   = chosen ? chosen.price : item.price;
  const addonTotal  = toggleAddons.filter(a => selAddons.includes(a.id)).reduce((s, a) => s + (a.price || 0), 0);
  const finalPrice  = basePrice + addonTotal;

  const toggleAddon = (id) =>
    setSelAddons(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const handleAdd = () => {
    const addonLabels = [
      ...toggleAddons.filter(a => selAddons.includes(a.id)).map(a => `${a.label}${a.price ? ` +₹${a.price}` : ""}`),
      spiceAddon ? `${spice} 🌶` : "",
    ].filter(Boolean);

    onAdd({
      ...item,
      selectedVariant: chosen?.label || null,
      finalPrice,
      qty,
      addonLabels,
      spiceLevel: spiceAddon ? spice : null,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full bg-white rounded-t-3xl max-w-xl mx-auto" onClick={e => e.stopPropagation()}
        style={{ maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
        <div className="w-10 h-1 bg-stone-200 rounded-full mx-auto mt-3 mb-4 flex-shrink-0" />

        <div className="flex-1 overflow-y-auto px-5 pb-2">
          {/* Header */}
          <div className="flex items-start gap-3 mb-4">
            <ItemThumb item={item} className="w-16 h-16" />
            <div className="flex-1">
              <h3 className="font-bold text-stone-800 text-base">{item.name}</h3>
              {item.description && <p className="text-xs text-stone-400 mt-0.5 leading-snug">{item.description}</p>}
            </div>
            <button onClick={onClose} className="w-7 h-7 rounded-full bg-stone-100 flex items-center justify-center flex-shrink-0">
              <X size={14} className="text-stone-500" />
            </button>
          </div>

          {/* Variants */}
          {hasVariants && (
            <div className="mb-4">
              <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-2">Choose Size</p>
              <div className="flex gap-2">
                {item.variants.map((v, i) => (
                  <button key={i} onClick={() => setSelVariant(i)}
                    className={`flex-1 py-3 rounded-2xl text-sm font-bold border-2 transition-all ${selVariant === i ? "border-orange-500 bg-orange-50 text-orange-700" : "border-stone-200 text-stone-500"}`}>
                    {v.label}<div className="text-xs font-medium mt-0.5">₹{v.price}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Spice level */}
          {spiceAddon && (
            <div className="mb-4">
              <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-2">🌶 Spice Level</p>
              <div className="flex gap-2">
                {(spiceAddon.options || ["Mild", "Medium", "Extra Hot"]).map(opt => (
                  <button key={opt} onClick={() => setSpice(opt)}
                    className={`flex-1 py-2.5 rounded-xl text-xs font-bold border-2 transition-all ${spice === opt ? "border-red-500 bg-red-50 text-red-700" : "border-stone-200 text-stone-500"}`}>
                    {opt === "Mild" ? "😊 Mild" : opt === "Medium" ? "🌶 Medium" : "🔥 Extra Hot"}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Toggle addons */}
          {toggleAddons.length > 0 && (
            <div className="mb-4">
              <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-2">Add Extras</p>
              <div className="space-y-2">
                {toggleAddons.map(a => (
                  <button key={a.id} onClick={() => toggleAddon(a.id)}
                    className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all ${selAddons.includes(a.id) ? "border-orange-400 bg-orange-50" : "border-stone-100 bg-stone-50"}`}>
                    <span className="text-sm font-medium text-stone-700">{a.label}</span>
                    <div className="flex items-center gap-2">
                      {a.price > 0 && <span className="text-xs text-orange-600 font-bold">+₹{a.price}</span>}
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${selAddons.includes(a.id) ? "bg-orange-500 border-orange-500" : "border-stone-300"}`}>
                        {selAddons.includes(a.id) && <CheckCircle size={12} className="text-white" />}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 pb-6 pt-3 border-t border-stone-100 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-3 bg-stone-100 rounded-2xl px-4 py-2.5">
              <button onClick={() => setQty(q => Math.max(1, q - 1))} className="w-8 h-8 flex items-center justify-center"><Minus size={14} className="text-stone-600" /></button>
              <span className="text-sm font-black text-stone-800 w-5 text-center">{qty}</span>
              <button onClick={() => setQty(q => q + 1)} className="w-8 h-8 flex items-center justify-center"><Plus size={14} className="text-stone-600" /></button>
            </div>
            <button onClick={handleAdd}
              className="flex-1 bg-gradient-to-r from-orange-500 to-red-500 text-white py-3.5 rounded-2xl font-bold text-sm shadow-lg active:scale-95 transition-transform">
              Add — ₹{finalPrice * qty}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── CART DRAWER ───────────────────────────────────────────
function CartDrawer({ cart, tableLabel, orderType, customerInfo, settings, onClose, onQty, onRemove, onPlace, unavailableIds = new Set(), validationError = null, supabaseDown = false, menu = {}, bestsellers = new Set(), onAddSuggested, validating = false, promoBannerUrl = null }) {
  const comboSuggestions = useComboSuggestions(cart, menu);
  const [note, setNote]           = useState("");
  const [promoCode, setPromoCode] = useState("");
  const [promo, setPromo]         = useState(null);
  const [promoErr, setPromoErr]   = useState("");
  const [applying, setApplying]   = useState(false);

  const subtotal = cart.reduce((s, i) => s + i.finalPrice * i.qty, 0);
  const discount = promo
    ? promo.discount_type === "percent"
      ? Math.min(Math.round(subtotal * promo.discount_value / 100), promo.max_discount || 9999)
      : promo.discount_value
    : 0;
  const afterDiscount = Math.max(0, subtotal - discount);

  const [roadDistanceKm, setRoadDistanceKm] = useState(null);
  const [fetchingDist,   setFetchingDist]   = useState(false);
  const [isApproxDist,   setIsApproxDist]   = useState(false);

  // Fetch actual road distance from OSRM whenever customer location changes
  useEffect(() => {
    if (orderType !== "delivery" || !customerInfo?.lat || !customerInfo?.lng) return;
    const rLat = settings.restaurant_lat || 26.926287;
    const rLng = settings.restaurant_lng || 80.942995;
    setFetchingDist(true);
    setIsApproxDist(false);
    fetch(`https://router.project-osrm.org/route/v1/driving/${rLng},${rLat};${customerInfo.lng},${customerInfo.lat}?overview=false`)
      .then(r => r.json())
      .then(d => {
        const km = d.routes?.[0]?.distance / 1000;
        setRoadDistanceKm(km ?? null);
        setIsApproxDist(false);
      })
      .catch(() => {
        // OSRM failed — fallback to haversine with 1.3x buffer to cover road vs straight-line gap
        const straight = haversineKm(rLat, rLng, customerInfo.lat, customerInfo.lng);
        setRoadDistanceKm(straight != null ? straight * 1.3 : null);
        setIsApproxDist(true);
      })
      .finally(() => setFetchingDist(false));
  }, [customerInfo?.lat, customerInfo?.lng, orderType, settings.restaurant_lat, settings.restaurant_lng]);

  const distanceKm = roadDistanceKm;
  const deliveryCalc = orderType === "delivery" ? calculateDelivery(distanceKm, afterDiscount, settings) : null;
  const deliveryFee  = deliveryCalc?.deliverable ? deliveryCalc.fee : 0;
  const packingCharge = orderType !== "dine-in" ? (settings.packing_charge || 0) : 0;
  const gstAmount = Math.round(afterDiscount * (settings.gst_percent || 0) / 100);
  const total = afterDiscount + deliveryFee + packingCharge + gstAmount;

  const belowMinOrder = settings.min_order_value > 0 && subtotal < settings.min_order_value;
  const blockedByDeliveryRadius = orderType === "delivery" && deliveryCalc && deliveryCalc.deliverable === false;
  const canPlace = !belowMinOrder && !blockedByDeliveryRadius;

  const typeLabel = orderType === "delivery" ? "🛵 Delivery" : orderType === "takeaway" ? "📦 Takeaway" : null;

  const applyPromo = async () => {
    if (!promoCode.trim()) return;
    setApplying(true); setPromoErr("");
    if (!SUPABASE_READY) { setPromoErr("Promo codes not available."); setApplying(false); return; }
    const { data, error } = await supabase.from("coupons")
      .select("*").eq("code", promoCode.trim().toUpperCase()).eq("is_active", true).single();
    setApplying(false);
    if (error || !data) { setPromoErr("Invalid or expired code."); return; }
    if (data.min_order && subtotal < data.min_order) { setPromoErr(`Minimum order ₹${data.min_order} required.`); return; }
    if (data.expiry && new Date(data.expiry) < new Date()) { setPromoErr("This code has expired."); return; }
    setPromo(data);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full bg-white rounded-t-3xl max-w-xl mx-auto flex flex-col" style={{ maxHeight: "90vh" }} onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 bg-stone-200 rounded-full mx-auto mt-3 flex-shrink-0" />
        <div className="flex items-center justify-between px-5 pt-3 pb-3 border-b border-stone-100 flex-shrink-0">
          <h3 className="font-bold text-stone-800 text-base flex items-center gap-2">
            <ShoppingCart size={18} className="text-orange-500" /> Your Cart
          </h3>
          <div className="flex items-center gap-2">
            <span className="text-[11px] bg-orange-100 text-orange-700 font-bold px-2 py-1 rounded-lg">{tableLabel || typeLabel || "Menu"}</span>
            <button onClick={onClose} className="w-7 h-7 rounded-full bg-stone-100 flex items-center justify-center"><X size={14} className="text-stone-500" /></button>
          </div>
        </div>
        {customerInfo && (
          <div className="px-5 py-2 bg-orange-50 border-b border-orange-100 flex-shrink-0 flex items-center gap-2">
            <User size={13} className="text-orange-500" />
            <span className="text-xs font-bold text-stone-700">{customerInfo.name}</span>
            <span className="text-[11px] text-stone-400">{customerInfo.phone}</span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {/* Feature 8: unavailability warning */}
          {(() => {
            const affected = cart.filter(it => unavailableIds.has(it.id));
            if (!affected.length) return null;
            return (
              <div className="bg-amber-50 border border-amber-300 rounded-2xl px-4 py-3 mb-3">
                {affected.map(it => (
                  <p key={it.id} className="text-xs font-bold text-amber-800">⚠️ {it.name} is no longer available — please remove it before ordering.</p>
                ))}
              </div>
            );
          })()}
          {/* Items */}
          {cart.map((item, i) => (
            <div key={i} className={`flex items-start gap-3 py-3 border-b border-stone-50 last:border-0 ${unavailableIds.has(item.id) ? "bg-red-50 rounded-xl px-2 border-red-200 border" : ""}`}>
              <ItemThumb item={item} className="w-12 h-12" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-stone-800 leading-tight">{item.name}</p>
                {item.selectedVariant && <p className="text-xs text-stone-400">{item.selectedVariant}</p>}
                {item.addonLabels?.length > 0 && (
                  <p className="text-[11px] text-orange-500 mt-0.5">{item.addonLabels.join(" · ")}</p>
                )}
                <p className="text-xs font-bold text-orange-600 mt-0.5">₹{item.finalPrice}</p>
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <button onClick={() => onRemove(i)} className="text-stone-300 hover:text-red-400 transition-colors"><Trash2 size={13} /></button>
                <div className="flex items-center gap-1.5 bg-orange-50 border border-orange-200 rounded-xl px-2 py-1">
                  <button onClick={() => onQty(i, item.qty - 1)} className="w-6 h-6 flex items-center justify-center"><Minus size={11} className="text-stone-600" /></button>
                  <span className="text-xs font-black text-stone-800 w-4 text-center">{item.qty}</span>
                  <button onClick={() => onQty(i, item.qty + 1)} className="w-6 h-6 flex items-center justify-center"><Plus size={11} className="text-stone-600" /></button>
                </div>
              </div>
            </div>
          ))}

          {/* Note */}
          <div className="mt-4">
            <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-2">Special Instructions</p>
            <textarea value={note} onChange={e => setNote(e.target.value)}
              placeholder="Less spicy, no onion, extra sauce…"
              className="w-full text-xs text-stone-700 bg-stone-50 border border-stone-200 rounded-2xl p-3 resize-none h-16 outline-none focus:border-orange-400 transition-colors" />
          </div>

          {/* 🎉 Super Saver Combo Suggestions */}
          {comboSuggestions.length > 0 && (
            <div className="mt-3 mb-2">
              <p className="text-[10px] font-black text-green-700 uppercase tracking-widest mb-2">🎉 Super Saver!</p>
              <div className="space-y-2">
                {comboSuggestions.map(({ combo }) => (
                  <div key={combo.id} className="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-2xl p-3 flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl overflow-hidden flex-shrink-0 bg-green-100">
                      <ItemThumb item={combo} className="w-full h-full rounded-none object-cover" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] font-black text-green-700 mb-0.5">Better Value Combo</p>
                      <p className="text-xs font-bold text-stone-800 leading-tight">{combo.name}</p>
                      {combo.description && <p className="text-[9px] text-stone-500 mt-0.5 line-clamp-1">{combo.description}</p>}
                      <p className="text-sm font-black text-green-600 mt-0.5">₹{combo.price}</p>
                    </div>
                    <button onClick={() => onAddSuggested && onAddSuggested(combo)}
                      className="flex-shrink-0 bg-green-500 text-white font-black text-xs px-3 py-2 rounded-xl active:scale-95 transition-all shadow-sm">
                      ADD
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 🛒 People Also Ordered */}
          {(() => {
            const cartIds = new Set(cart.map(c => c.id));
            const allItems = Object.values(menu).flat();
            const cartCats = new Set(cart.map(c => allItems.find(i => i.id === c.id)?.category).filter(Boolean));
            const suggestions = allItems.filter(i =>
              bestsellers.has(i.id) &&
              !cartIds.has(i.id) &&
              i.is_available !== false &&
              (cartCats.has(i.category) || cartCats.size === 0)
            ).slice(0, 4);
            if (suggestions.length === 0) return null;
            return (
              <div className="mt-3 mb-3">
                <p className="text-[10px] font-black text-stone-500 uppercase tracking-widest mb-2">🛒 People Also Ordered</p>
                <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
                  {suggestions.map(item => (
                    <button key={item.id} onClick={() => onAddSuggested && onAddSuggested(item)}
                      className="flex-shrink-0 bg-orange-50 border border-orange-100 rounded-2xl p-2 flex items-center gap-2 active:scale-95 transition-all min-w-[140px]">
                      <div className="w-10 h-10 rounded-xl overflow-hidden flex-shrink-0 bg-stone-100">
                        <ItemThumb item={item} className="w-full h-full rounded-none object-cover" />
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <p className="text-[10px] font-bold text-stone-800 leading-tight line-clamp-2">{item.name}</p>
                        <p className="text-[10px] font-black text-orange-600 mt-0.5">+ ₹{item.price}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Promo code */}
          <div className="mt-4">
            <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-2 flex items-center gap-1"><Tag size={10} /> Promo Code</p>
            {promo ? (
              <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-2xl px-4 py-3">
                <div>
                  <p className="text-xs font-bold text-green-700">🎉 "{promo.code}" applied!</p>
                  <p className="text-xs text-green-600">You saved ₹{discount}</p>
                </div>
                <button onClick={() => { setPromo(null); setPromoCode(""); }} className="text-xs text-stone-400 hover:text-red-500"><X size={14} /></button>
              </div>
            ) : (
              <div className="flex gap-2">
                <input value={promoCode} onChange={e => { setPromoCode(e.target.value.toUpperCase()); setPromoErr(""); }}
                  placeholder="Enter code (e.g. BURGER10)"
                  className="flex-1 text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2.5 outline-none text-stone-700 uppercase font-mono" />
                <button onClick={applyPromo} disabled={applying || !promoCode.trim()}
                  className="bg-orange-500 text-white text-xs font-bold px-4 rounded-xl disabled:opacity-50">
                  {applying ? "…" : "Apply"}
                </button>
              </div>
            )}
            {promoErr && <p className="text-red-500 text-xs mt-1">{promoErr}</p>}
          </div>

          {/* Bill */}
          <div className="mt-4 bg-orange-50 rounded-2xl p-4 border border-orange-100">
            <div className="flex justify-between text-sm text-stone-600 mb-1">
              <span>Subtotal</span><span>₹{subtotal}</span>
            </div>
            {discount > 0 && (
              <div className="flex justify-between text-sm text-green-600 mb-1">
                <span>Discount ({promo.code})</span><span>−₹{discount}</span>
              </div>
            )}
            {orderType === "delivery" && deliveryCalc?.deliverable && (
              <>
                <div className="flex justify-between text-sm text-stone-600 mb-1">
                  <span>Delivery {fetchingDist ? "(checking…)" : deliveryCalc.distanceKm != null ? `(~${deliveryCalc.distanceKm.toFixed(1)} km${isApproxDist ? " approx" : " road"})` : ""}</span>
                  <span>{deliveryCalc.freeDelivery ? "FREE" : `₹${deliveryFee}`}</span>
                </div>
                {isApproxDist && !fetchingDist && (
                  <div className="flex items-start gap-1.5 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mb-2 text-xs text-amber-700">
                    <span className="flex-shrink-0">⚠️</span>
                    <span>Distance is approximate — road routing unavailable right now. Actual delivery fee may vary slightly.</span>
                  </div>
                )}
              </>
            )}
            {packingCharge > 0 && (
              <div className="flex justify-between text-sm text-stone-600 mb-1">
                <span>Packing Charge</span><span>₹{packingCharge}</span>
              </div>
            )}
            {gstAmount > 0 && (
              <div className="flex justify-between text-sm text-stone-600 mb-1">
                <span>GST ({settings.gst_percent}%)</span><span>₹{gstAmount}</span>
              </div>
            )}
            <div className="flex justify-between text-sm font-bold text-stone-800 border-t border-orange-100 pt-2 mt-1">
              <span>Total</span><span className="text-orange-600">₹{total}</span>
            </div>
          </div>

          {blockedByDeliveryRadius && (
            <div className="mt-3 bg-red-50 border border-red-200 rounded-2xl p-3 text-xs text-red-600">{deliveryCalc.reason}</div>
          )}
          {belowMinOrder && !blockedByDeliveryRadius && (
            <div className="mt-3 bg-amber-50 border border-amber-200 rounded-2xl p-3 text-xs text-amber-700">
              Minimum order is ₹{settings.min_order_value} — add ₹{settings.min_order_value - subtotal} more to continue.
            </div>
          )}
          <div className="h-4" />
        </div>

        <div className="px-5 pb-6 pt-3 border-t border-stone-100 flex-shrink-0">
          {validationError && (
            <div className="bg-red-50 border border-red-200 rounded-2xl px-4 py-3 mb-3 text-xs text-red-700 font-medium">{validationError}</div>
          )}
          {supabaseDown ? (
            <>
              <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 mb-3 text-xs text-amber-800 font-medium text-center">
                ⚠️ Our server is temporarily down. Place your order via WhatsApp!
              </div>
              <button
                disabled={!canPlace}
                onClick={() => {
                  const typeLabel = orderType === "delivery" ? "🛵 Delivery" : orderType === "takeaway" ? "📦 Takeaway" : `🍽️ Dine-in${tableLabel ? ` (${tableLabel})` : ""}`;
                  const lines = cart.map(i => {
                    const variant = i.selectedVariant ? ` (${i.selectedVariant})` : "";
                    const addons  = i.addonLabels?.length ? ` + ${i.addonLabels.join(", ")}` : "";
                    return `• ${i.name}${variant}${addons} × ${i.qty}  ₹${i.finalPrice * i.qty}`;
                  }).join("\n");
                  const nameLine  = customerInfo?.name  ? `\n👤 Name: ${customerInfo.name}`    : "";
                  const phoneLine = customerInfo?.phone ? `\n📞 Phone: ${customerInfo.phone}`  : "";
                  const addrLine  = customerInfo?.address ? `\n📍 Address: ${customerInfo.address}` : "";
                  const tableLine = tableLabel ? `\n🪑 Table: ${tableLabel}` : "";
                  const noteLine  = note.trim() ? `\n📝 Note: ${note.trim()}` : "";
                  const msg = `🍔 *Burger Point Order*\n──────────────────\n${lines}\n──────────────────\n💰 *Total: ₹${total}*\n🛒 ${typeLabel}${tableLine}${nameLine}${phoneLine}${addrLine}${noteLine}`;
                  window.open(`${WHATSAPP}?text=${encodeURIComponent(msg)}`, "_blank");
                }}
                className="w-full bg-gradient-to-r from-green-500 to-green-600 text-white py-4 rounded-2xl font-bold text-sm shadow-lg active:scale-95 transition-transform disabled:opacity-40 disabled:pointer-events-none flex items-center justify-center gap-2">
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                Order via WhatsApp · ₹{total}
              </button>
              <p className="text-center text-[10px] text-stone-400 mt-2">Opens WhatsApp with your full order details</p>
            </>
          ) : (
            <>
              {/* Promo banner block — shown if admin has enabled a banner */}
              {promoBannerUrl && <PromoBannerBlock url={promoBannerUrl} />}
              <button onClick={() => onPlace({ note, total, discount, promoCode: promo?.code, deliveryFee, packingCharge, gstAmount, distanceKm: deliveryCalc?.distanceKm ?? null })}
                disabled={!canPlace || validating}
                className="w-full bg-gradient-to-r from-orange-500 to-red-600 text-white py-4 rounded-2xl font-bold text-sm shadow-lg active:scale-95 transition-transform disabled:opacity-40 disabled:pointer-events-none flex items-center justify-center gap-2">
                {validating
                  ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Checking…</>
                  : <>🍔 Place Order · ₹{total}</>}
              </button>
              <p className="text-center text-[10px] text-stone-400 mt-2">
                {validating ? "Verifying your items…" : "Order sent directly to kitchen"}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── REAL RAZORPAY MODAL ───────────────────────────────────
const RZP_KEY_ID = import.meta.env.VITE_RAZORPAY_KEY_ID || "";

function RazorpayModal({ amount, customerName, customerPhone, orderId, onSuccess, onClose, onCancel, onCash }) {
  const [loading,        setLoading]        = useState(false);
  const [err,            setErr]            = useState("");
  const [failed,         setFailed]         = useState(false);
  const [scriptFailures, setScriptFailures] = useState(0); // track consecutive load failures
  // Tracks whether Razorpay checkout was opened — disables Cash fallback to prevent
  // the race condition where ondismiss fires before handler after a successful capture.
  const [rzpOpened,  setRzpOpened]  = useState(false);
  // Ref so the ondismiss closure always sees the latest value without a stale capture.
  const paymentCapturedRef = useRef(false);

  // Retries the script load once after 1.5s before giving up.
  const loadScript = () =>
    new Promise(resolve => {
      if (window.Razorpay) { resolve(true); return; }
      const tryLoad = (isRetry = false) => {
        // Remove any stale failed script tag before retrying
        document.querySelectorAll("script[src*='razorpay']").forEach(s => s.remove());
        const s = document.createElement("script");
        s.src = "https://checkout.razorpay.com/v1/checkout.js";
        s.onload  = () => resolve(true);
        s.onerror = () => {
          if (!isRetry) setTimeout(() => tryLoad(true), 1500); // one retry after 1.5s
          else resolve(false);
        };
        document.body.appendChild(s);
      };
      tryLoad();
    });

  const openRazorpay = async () => {
    setLoading(true); setErr(""); setFailed(false);
    paymentCapturedRef.current = false;
    const ok = await loadScript();
    setLoading(false);
    if (!ok) {
      const failures = scriptFailures + 1;
      setScriptFailures(failures);
      // After 2 failures, strongly nudge cash — don't leave them stranded
      setErr(failures >= 2
        ? "Razorpay couldn't load (poor connection). Please use Cash below — your order is safe."
        : "Could not load payment page. Check your connection and try again.");
      return;
    }

    // Log every Razorpay attempt to Supabase so no payment event is ever lost.
    // Fires for success, failure, and dismiss — gives full audit trail.
    const logRazorpayEvent = async (event, extra = {}) => {
      try {
        if (typeof supabase !== "undefined") {
          await supabase.from("razorpay_events").insert({
            event,
            amount,
            customer_name: customerName || null,
            customer_phone: customerPhone || null,
            created_at: new Date().toISOString(),
            ...extra,
          });
        }
      } catch (e) {
        // Non-blocking — never fail the payment flow because of a log write
        // razorpay_events log failed — non-critical
      }
    };

    const options = {
      key: RZP_KEY_ID,
      amount: amount * 100,
      currency: "INR",
      name: "Burger Point",
      description: "Food Order",
      prefill: { name: customerName || "", contact: customerPhone || "" },
      theme: { color: "#f97316" },
      notes: orderId ? { burger_point_order_id: orderId } : undefined,
      handler: (response) => {
        // Mark captured BEFORE calling onSuccess so ondismiss (which may fire
        // right after on some devices/browsers) sees the flag and bails out.
        paymentCapturedRef.current = true;
        logRazorpayEvent("success", { razorpay_payment_id: response.razorpay_payment_id });
        onSuccess(response.razorpay_payment_id);
      },
      modal: {
        ondismiss: () => {
          // If payment was already captured, do nothing — finaliseOrder is already
          // running via handler above. Without this guard, ondismiss fires right
          // after handler on some Android browsers and would trigger a duplicate path.
          if (paymentCapturedRef.current) return;
          logRazorpayEvent("dismissed");
          setLoading(false);
        },
      },
    };

    const rzp = new window.Razorpay(options);
    rzp.on("payment.failed", (resp) => {
      const desc = resp.error?.description || "Unknown error";
      const code = resp.error?.code || null;
      logRazorpayEvent("failed", { error_description: desc, error_code: code });
      setFailed(true);
      setErr("Payment failed: " + (resp.error?.description || "Please try again."));
    });
    setRzpOpened(true);   // lock out Cash button from this point on
    rzp.open();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/70 backdrop-blur-sm"
      onClick={() => { if (!rzpOpened && !loading) onCancel?.(); }}>
      <div className="w-full bg-white rounded-t-3xl max-w-lg mx-auto p-6" onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 bg-stone-200 rounded-full mx-auto mb-5" />
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center">
            <span className="text-white font-black text-base">R</span>
          </div>
          <div>
            <p className="font-black text-stone-800">Burger Point</p>
            <p className="text-xs text-stone-400">Secured by Razorpay · 256-bit SSL</p>
          </div>
          <div className="ml-auto text-right">
            <p className="text-xs text-stone-400">Total</p>
            <p className="font-black text-stone-900 text-xl">₹{amount}</p>
          </div>
        </div>

        {err && (
          <div className="bg-red-50 border border-red-200 rounded-2xl px-4 py-3 mb-4">
            <p className="text-sm font-bold text-red-600 mb-1">❌ {failed ? "Payment Failed" : "Error"}</p>
            <p className="text-xs text-red-500">{err}</p>
          </div>
        )}

        <button onClick={openRazorpay} disabled={loading}
          className="w-full bg-gradient-to-r from-blue-600 to-blue-700 text-white py-4 rounded-2xl font-bold text-sm shadow-md active:scale-95 transition-transform disabled:opacity-60 flex items-center justify-center gap-2 mb-3">
          {loading
            ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Loading…</>
            : failed ? <>🔄 Try Again</> : <>💳 Pay ₹{amount} Online</>}
        </button>

        <button onClick={onCash} disabled={rzpOpened}
          className={`w-full border-2 text-sm font-bold py-3.5 rounded-2xl transition-all disabled:opacity-40 disabled:cursor-not-allowed
            ${scriptFailures >= 2 && !rzpOpened
              ? "border-orange-400 bg-orange-50 text-orange-700 animate-pulse"
              : "border-dashed border-stone-200 text-stone-500 hover:border-orange-300 hover:text-orange-600 disabled:hover:border-stone-200 disabled:hover:text-stone-500"}`}>
          💵 Pay Cash at Counter / Door
        </button>
        {scriptFailures >= 2 && !rzpOpened && (
          <p className="text-center text-[10px] text-orange-500 font-bold mt-1">
            ↑ Recommended due to poor connection
          </p>
        )}
        {rzpOpened && (
          <p className="text-center text-[10px] text-stone-400 mt-1">
            Payment in progress — please complete or close the Razorpay window
          </p>
        )}

        <div className="flex items-center justify-center gap-4 mt-4">
          <span className="text-[10px] text-stone-400">🔒 100% Secure</span>
          <span className="text-[10px] text-stone-400">|</span>
          <span className="text-[10px] text-stone-400">UPI · Cards · NetBanking</span>
        </div>
      </div>
    </div>
  );
}

// ── MINI GAMES (shown while order is preparing) ───────────

function SnakeGame() {
  const COLS = 16, ROWS = 16, CELL = 18;
  const dirs = { UP: [0,-1], DOWN: [0,1], LEFT: [-1,0], RIGHT: [1,0] };
  const [snake, setSnake]   = useState([[8,8],[7,8],[6,8]]);
  const [food,  setFood]    = useState([12,5]);
  const [dir,   setDir]     = useState("RIGHT");
  const [score, setScore]   = useState(0);
  const [best,  setBest]    = useState(() => +lsGet("bp_snake_best", "0") || 0);
  const [dead,  setDead]    = useState(false);
  const [started, setStarted] = useState(false);
  const nextDir = useRef("RIGHT");
  const gameRef = useRef(null);

  const randFood = (sn) => {
    let f;
    do { f = [Math.floor(Math.random()*COLS), Math.floor(Math.random()*ROWS)]; }
    while (sn.some(([x,y]) => x===f[0] && y===f[1]));
    return f;
  };

  const reset = () => {
    const s = [[8,8],[7,8],[6,8]];
    setSnake(s); setFood(randFood(s)); setDir("RIGHT"); setScore(0); setDead(false); setStarted(true);
    nextDir.current = "RIGHT";
    gameRef.current?.focus();
  };

  useEffect(() => {
    if (!started || dead) return;
    const speed = Math.max(80, 160 - score * 4);
    const t = setInterval(() => {
      setSnake(prev => {
        const d = dirs[nextDir.current];
        setDir(nextDir.current);
        const head = [(prev[0][0] + d[0] + COLS) % COLS, (prev[0][1] + d[1] + ROWS) % ROWS];
        if (prev.some(([x,y]) => x===head[0] && y===head[1])) {
          setDead(true);
          setScore(sc => { const ns = sc; setBest(b => { const nb=Math.max(b,ns); lsSet("bp_snake_best", String(nb)); return nb; }); return sc; });
          return prev;
        }
        setFood(f => {
          if (head[0]===f[0] && head[1]===f[1]) {
            setScore(s => s+1);
            const grown = [head, ...prev];
            const nf = randFood(grown);
            setTimeout(() => setFood(nf), 0);
            return nf;
          }
          return f;
        });
        return [head, ...prev.slice(0,-1)];
      });
    }, speed);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, dead, score]);

  const handleKey = useCallback((e) => {
    const map = { ArrowUp:"UP", ArrowDown:"DOWN", ArrowLeft:"LEFT", ArrowRight:"RIGHT",
                  w:"UP", s:"DOWN", a:"LEFT", d:"RIGHT" };
    const nd = map[e.key];
    if (!nd) return;
    e.preventDefault();
    const opp = { UP:"DOWN", DOWN:"UP", LEFT:"RIGHT", RIGHT:"LEFT" };
    if (nd !== opp[nextDir.current]) nextDir.current = nd;
  }, []);

  // Touch swipe
  const touch = useRef({});
  const onTouchStart = (e) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; };
  const onTouchEnd   = (e) => {
    const dx = e.changedTouches[0].clientX - touch.current.x;
    const dy = e.changedTouches[0].clientY - touch.current.y;
    if (Math.abs(dx) > Math.abs(dy)) nextDir.current = dx > 0 ? "RIGHT" : "LEFT";
    else nextDir.current = dy > 0 ? "DOWN" : "UP";
  };

  const W = COLS*CELL, H = ROWS*CELL;

  return (
    <div className="flex flex-col items-center gap-3" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div className="flex items-center justify-between w-full px-1">
        <div className="text-xs font-bold text-white/70">Score <span className="text-orange-400 text-sm">{score}</span></div>
        <div className="text-xs font-bold text-white/70">Best <span className="text-yellow-400 text-sm">{best}</span></div>
      </div>
      <div tabIndex={0} ref={gameRef} onKeyDown={handleKey}
        className="relative rounded-2xl overflow-hidden outline-none cursor-pointer"
        style={{ width: W, height: H, background: "#0d1117", border: "2px solid rgba(249,115,22,0.3)", touchAction:"none" }}
        onClick={() => { if (!started || dead) reset(); }}>

        {/* Grid dots */}
        {Array.from({length:COLS}).map((_,cx) => Array.from({length:ROWS}).map((_,ry) => (
          <div key={`${cx}-${ry}`} style={{ position:"absolute", left: cx*CELL+CELL/2-1, top: ry*CELL+CELL/2-1, width:2, height:2, borderRadius:"50%", background:"rgba(255,255,255,0.05)" }} />
        )))}

        {/* Food */}
        <div style={{ position:"absolute", left:food[0]*CELL, top:food[1]*CELL, width:CELL, height:CELL, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, animation:"sadBounce 0.7s ease-in-out infinite" }}>🍔</div>

        {/* Snake */}
        {snake.map(([x,y], i) => (
          <div key={i} style={{
            position:"absolute", left:x*CELL+1, top:y*CELL+1, width:CELL-2, height:CELL-2, borderRadius: i===0?6:4,
            background: i===0
              ? "linear-gradient(135deg,#f97316,#ef4444)"
              : `rgba(249,115,22,${Math.max(0.25, 1 - i*0.06)})`,
            boxShadow: i===0 ? "0 0 8px rgba(249,115,22,0.8)" : "none",
            transition: "none",
          }} />
        ))}

        {/* Overlay states */}
        {(!started || dead) && (
          <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.75)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:8 }}>
            {dead ? (
              <>
                <span style={{fontSize:36}}>💀</span>
                <p style={{color:"#fff",fontWeight:900,fontSize:16}}>Game Over!</p>
                <p style={{color:"rgba(255,255,255,0.6)",fontSize:12}}>Score: {score}</p>
                <div style={{background:"linear-gradient(135deg,#f97316,#ef4444)",color:"#fff",fontWeight:800,fontSize:12,padding:"8px 20px",borderRadius:12,cursor:"pointer",marginTop:4}}>Tap to Retry</div>
              </>
            ) : (
              <>
                <span style={{fontSize:36}}>🐍</span>
                <p style={{color:"#fff",fontWeight:900,fontSize:15}}>Snake Attack!</p>
                <p style={{color:"rgba(255,255,255,0.5)",fontSize:11,textAlign:"center",padding:"0 16px"}}>Swipe or use arrow keys · eat the 🍔</p>
                <div style={{background:"linear-gradient(135deg,#f97316,#ef4444)",color:"#fff",fontWeight:800,fontSize:12,padding:"8px 20px",borderRadius:12,cursor:"pointer",marginTop:4}}>Tap to Play</div>
              </>
            )}
          </div>
        )}
      </div>

    </div>
  );
}

function TicTacToe() {
  const [board, setBoard] = useState(Array(9).fill(null));
  const [xTurn, setXTurn] = useState(true);
  const [winner, setWinner] = useState(null);
  const [scores, setScores] = useState({X:0,O:0,D:0});
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

  const checkWin = (b) => {
    for (const [a,c,d] of lines) { if (b[a] && b[a]===b[c] && b[a]===b[d]) return b[a]; }
    return b.every(Boolean) ? "D" : null;
  };

  const aiMove = useCallback((b) => {
    // minimax-lite: try to win, block, else random
    for (const line of lines) {
      const [a,c,d] = line; const vals=[b[a],b[c],b[d]];
      if (vals.filter(v=>v==="O").length===2 && vals.includes(null)) { const i=line[vals.indexOf(null)]; const nb=[...b]; nb[i]="O"; return nb; }
    }
    for (const line of lines) {
      const [a,c,d] = line; const vals=[b[a],b[c],b[d]];
      if (vals.filter(v=>v==="X").length===2 && vals.includes(null)) { const i=line[vals.indexOf(null)]; const nb=[...b]; nb[i]="O"; return nb; }
    }
    if (!b[4]) { const nb=[...b]; nb[4]="O"; return nb; }
    const empty = b.map((v,i)=>v?null:i).filter(v=>v!==null);
    if (!empty.length) return b;
    const nb=[...b]; nb[empty[Math.floor(Math.random()*empty.length)]]="O"; return nb;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClick = (i) => {
    if (!xTurn || board[i] || winner) return;
    const nb=[...board]; nb[i]="X";
    const w=checkWin(nb);
    setBoard(nb); setXTurn(false);
    if (w) { setWinner(w); setScores(s=>({...s,[w]:s[w]+1})); return; }
    setTimeout(()=>{
      const ab=aiMove(nb); const aw=checkWin(ab);
      setBoard(ab); setXTurn(true);
      if (aw) { setWinner(aw); setScores(s=>({...s,[aw]:s[aw]+1})); }
    }, 350);
  };

  const reset = () => { setBoard(Array(9).fill(null)); setXTurn(true); setWinner(null); };

  const winLine = winner && winner!=="D" ? lines.find(([a,c,d])=>board[a]&&board[a]===board[c]&&board[a]===board[d]) : null;

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex gap-6 text-sm font-bold">
        <span className="text-orange-400">You (X): {scores.X}</span>
        <span className="text-white/30">Draws: {scores.D}</span>
        <span className="text-purple-400">AI (O): {scores.O}</span>
      </div>
      <div className="grid gap-2" style={{gridTemplateColumns:"repeat(3,72px)"}}>
        {board.map((v,i) => {
          const isWin = winLine?.includes(i);
          return (
            <button key={i} onClick={()=>handleClick(i)}
              className="h-[72px] rounded-2xl flex items-center justify-center text-3xl font-black transition-all active:scale-90"
              style={{
                background: isWin ? "linear-gradient(135deg,#f97316,#ef4444)" : "rgba(255,255,255,0.07)",
                border: `2px solid ${isWin?"rgba(249,115,22,0.8)":"rgba(255,255,255,0.12)"}`,
                color: v==="X"?"#fb923c":v==="O"?"#a78bfa":"transparent",
                boxShadow: isWin?"0 0 16px rgba(249,115,22,0.5)":"none",
                cursor: v||winner?"default":"pointer",
              }}>
              {v || "·"}
            </button>
          );
        })}
      </div>
      {winner ? (
        <div className="text-center">
          <p className="font-black text-lg text-white mb-1">
            {winner==="D"?"It's a draw! 🤝":winner==="X"?"You won! 🎉":"AI wins 🤖"}
          </p>
          <button onClick={reset}
            className="text-xs font-bold text-white px-5 py-2 rounded-xl active:scale-95 transition-transform"
            style={{background:"linear-gradient(135deg,#f97316,#ef4444)"}}>
            Play Again
          </button>
        </div>
      ) : (
        <p className="text-xs text-white/40 font-medium">{xTurn?"Your turn — tap a square":"AI is thinking…"}</p>
      )}
    </div>
  );
}

function WaitingGames() {
  const [game, setGame] = useState(null); // null=picker, "snake", "ttt"
  if (game === "snake") return (
    <div>
      <button onClick={()=>setGame(null)} className="flex items-center gap-1 text-xs text-white/40 font-bold mb-3">← Back</button>
      <SnakeGame />
    </div>
  );
  if (game === "ttt") return (
    <div>
      <button onClick={()=>setGame(null)} className="flex items-center gap-1 text-xs text-white/40 font-bold mb-3">← Back</button>
      <TicTacToe />
    </div>
  );
  return (
    <div className="flex gap-3">
      <button onClick={()=>setGame("snake")}
        className="flex-1 py-3 rounded-2xl flex flex-col items-center gap-1.5 active:scale-95 transition-transform"
        style={{background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.12)"}}>
        <span className="text-2xl">🐍</span>
        <span className="text-xs font-bold text-white/80">Snake</span>
        <span className="text-[10px] text-white/40">eat the burger</span>
      </button>
      <button onClick={()=>setGame("ttt")}
        className="flex-1 py-3 rounded-2xl flex flex-col items-center gap-1.5 active:scale-95 transition-transform"
        style={{background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.12)"}}>
        <span className="text-2xl">🎮</span>
        <span className="text-xs font-bold text-white/80">Tic-Tac-Toe</span>
        <span className="text-[10px] text-white/40">vs AI</span>
      </button>
    </div>
  );
}

// ── ORDER TRACKER ─────────────────────────────────────────
function OrderTracker({ order, tableLabel, onNewOrder }) {
  const [status,      setStatus]      = useState(order.status || "pending");
  const [riderName,   setRiderName]   = useState(order.rider_name || null);
  const [riderPhone,  setRiderPhone]  = useState(order.rider_phone || null);
  const [liveOrder,   setLiveOrder]   = useState(order); // tracks full order for route data
  const [reviewDone,  setReviewDone]  = useState(false);
  const [thumbSent,   setThumbSent]   = useState(null);
  const [gamesOpen,   setGamesOpen]   = useState(true);
  // Feature 1: stale banner
  // Fix 1: stale banner; Fix 5: pending stuck; Fix 15: delivery stuck
  const [isStale,          setIsStale]          = useState(false);
  const [isPendingStuck,   setIsPendingStuck]   = useState(false);
  // Feature 3: offline banner
  const [isOffline,   setIsOffline]   = useState(!navigator.onLine);
  // Feature 4: live ETA countdown
  const [etaText,     setEtaText]     = useState(null);
  const [waitTimes, setWaitTimes] = useState(() => {
    try { return JSON.parse(localStorage.getItem(SS_WAIT) || "{}"); } catch { return {}; }
  });

  // Fix 14: subscribe to live wait-time changes from business_settings
  useEffect(() => {
    if (!SUPABASE_READY) return;
    const ch = supabase.channel("biz-settings-wait")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "business_settings" }, (p) => {
        const d = p.new;
        const updated = {
          "dine-in":  d.wait_dine  || 15,
          takeaway:   d.wait_takeaway || 20,
          delivery:   d.wait_delivery || 40,
        };
        setWaitTimes(updated);
        lsSet(SS_WAIT, JSON.stringify(updated));
      })
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, []);

  // Fix 5 + Fix 15: stale-check covers pending >10 min AND accepted >25 min AND delivery accepted >30 min without rider
  const [isDeliveryStuck, setIsDeliveryStuck] = useState(false);

  useEffect(() => {
    const check = () => {
      const ageMs = Date.now() - new Date(order.created_at).getTime();
      const ot = order.order_type || "dine-in";
      if (status === "accepted") {
        setIsStale(ageMs > 25 * 60 * 1000);
        setIsDeliveryStuck(ot === "delivery" && !riderName && ageMs > 30 * 60 * 1000);
      } else {
        setIsStale(false);
        setIsDeliveryStuck(false);
      }
      setIsPendingStuck(status === "pending" && ageMs > 10 * 60 * 1000);
    };
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, [status, order.created_at, order.order_type, riderName]);

  // Feature 3: offline banner
  useEffect(() => {
    const goOnline = () => {
      setIsOffline(false);
      // Re-fetch order status immediately on reconnect
      if (SUPABASE_READY && order.id) {
        supabase.from("orders").select("status, rider_name, rider_phone").eq("id", order.id).single()
          .then(({ data }) => { if (data) applyUpdateRef.current?.(data); });
      }
    };
    const goOffline = () => setIsOffline(true);
    window.addEventListener("online",  goOnline);
    window.addEventListener("offline", goOffline);
    return () => { window.removeEventListener("online", goOnline); window.removeEventListener("offline", goOffline); };
  }, [order.id]);

  // Feature 4: ETA countdown
  useEffect(() => {
    const ot = order.order_type || "dine-in";
    const defaultWait = waitTimes[ot] || (ot === "delivery" ? 40 : ot === "takeaway" ? 20 : 15);
    if (status !== "pending" && status !== "accepted") { setEtaText(null); return; }
    const target = new Date(order.created_at).getTime() + defaultWait * 60000;
    const tick = () => {
      const diff = Math.round((target - Date.now()) / 1000);
      if (diff <= 0) { setEtaText("Any moment now…"); }
      else {
        const m = Math.floor(diff / 60), s = diff % 60;
        setEtaText(`${m}:${String(s).padStart(2, "0")}`);
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [status, order.created_at, order.order_type, waitTimes]);

  // Web Push subscription — register on tracker mount for customers
  useEffect(() => {
    if (!SUPABASE_READY || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
    (async () => {
      try {
        // Get VAPID public key from env variable
        const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
        if (!vapidKey) return; // Not configured yet

        const permission = await Notification.requestPermission();
        if (permission !== "granted") return;

        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          // Convert VAPID key from base64 to Uint8Array
          const key = vapidKey.replace(/-/g, "+").replace(/_/g, "/");
          const raw = Uint8Array.from(atob(key), c => c.charCodeAt(0));
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
        }
        // Save subscription to Supabase
        const subJson = sub.toJSON();
        await supabase.from("push_subscriptions").upsert({
          endpoint: subJson.endpoint,
          p256dh: subJson.keys?.p256dh,
          auth: subJson.keys?.auth,
          role: "customer",
        }, { onConflict: "endpoint" });
      } catch (e) {
        // push subscription failed — non-critical
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // Only fire the chime once, when the order is still brand-new (placed in the last 30s)
    const age = Date.now() - new Date(order.created_at).getTime();
    if (age > 30000) return; // resuming an old order — skip
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const playTone = (freq, start, duration) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = freq; osc.type = "sine";
        gain.gain.setValueAtTime(0.25, ctx.currentTime + start);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + duration);
      };
      playTone(523, 0, 0.15);   // C5
      playTone(659, 0.15, 0.15); // E5
      playTone(784, 0.3, 0.25);  // G5
    } catch {}
    try { navigator.vibrate?.([80, 40, 80]); } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fix 7: live kitchen busy indicator
  const [kitchenBusy, setKitchenBusy] = useState(null);
  useEffect(() => {
    if (!SUPABASE_READY) return;
    supabase.from("busy_mode").select("is_busy, message").eq("id", 1).single()
      .then(({ data }) => { if (data?.is_busy) setKitchenBusy(data.message || "Kitchen is very busy right now"); });
    const ch = supabase.channel("busy-mode-tracker")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "busy_mode", filter: "id=eq.1" }, (p) => {
        setKitchenBusy(p.new.is_busy ? (p.new.message || "Kitchen is very busy right now") : null);
      }).subscribe();
    return () => supabase.removeChannel(ch);
  }, []);

  // applyUpdateRef so offline handler can call applyUpdate without stale closure
  const applyUpdateRef = useRef(null);

  // Clear persisted order when served or cancelled — delay so customer refreshing
  // mid-completion still sees the served/done screen instead of jumping back to menu
  useEffect(() => {
    if (status === "served" || status === "cancelled") {
      const t = setTimeout(() => {
        lsRemove(LS_ACTIVE_ORDER);
        sessionStorage.removeItem(SS_ORDER);
      }, 3 * 60 * 1000); // keep for 3 minutes
      return () => clearTimeout(t);
    }
  }, [status]);

  // Feature 7: request notification permission on mount
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    if (!SUPABASE_READY || !order.id) return;

    const TERMINAL = new Set(["cancelled", "served"]);

    const applyUpdate = (data) => {
      if (!data) return;
      if (data.status) {
        // Feature 7: push notification on status change
        // _lastStatus is seeded below with order.status so resuming a page never
        // fires a notification for the status that was already known on mount.
        const prevStatus = applyUpdateRef.current?._lastStatus;
        if (data.status !== prevStatus && "Notification" in window && Notification.permission === "granted") {
          const NOTIF_MSGS = {
            accepted:  "👨‍🍳 Your order is being prepared!",
            ready:     "✅ Your order is ready!",
            dispatched:"🛵 Your rider is on the way!",
            served:    "😊 Order delivered — enjoy!",
            cancelled: "😔 Your order was cancelled",
          };
          const msg = NOTIF_MSGS[data.status];
          if (msg) {
            const n = new Notification("Burger Point", { body: msg });
            setTimeout(() => n.close(), 6000);
          }
        }
        setStatus(data.status);
        // As soon as the order reaches a terminal state, wipe the persisted copies
        // so that a page-refresh no longer shows a stale "dispatched" or "pending" screen.
        if (TERMINAL.has(data.status)) {
          lsRemove(LS_ACTIVE_ORDER);
          sessionStorage.removeItem(SS_ORDER);
        }
      }
      if (data.rider_name)  setRiderName(data.rider_name);
      if (data.rider_phone) setRiderPhone(data.rider_phone);
      setLiveOrder(prev => ({ ...prev, ...data }));
      // keep ref in sync for offline handler
      if (applyUpdateRef.current) applyUpdateRef.current._lastStatus = data.status || applyUpdateRef.current._lastStatus;
    };
    applyUpdateRef.current = applyUpdate;
    // Seed with the known status so the first fetch/realtime event doesn't
    // trigger a notification for a status the customer already saw.
    applyUpdateRef.current._lastStatus = order.status || null;

    const ORDER_FIELDS = "status, rider_name, rider_phone, route_geometry, route_distance_km, route_eta_minutes, delivery_started_at, customer_lat, customer_lng, cancel_reason, items, total, pending_addon_items, pending_addon_total, addon_requested_at, addon_declined_at";

    // 1. Fetch current state immediately on mount; retry once on failure
    const fetchNow = (retryMs = 0) => {
      supabase.from("orders").select(ORDER_FIELDS).eq("id", order.id).single()
        .then(({ data, error }) => {
          if (!error) applyUpdate(data);
          else if (retryMs > 0) setTimeout(() => fetchNow(0), retryMs);
        });
    };
    fetchNow(3000); // initial fetch; retry after 3 s if it fails

    // 2. Subscribe to real-time changes — fires the instant admin updates the row.
    //    NOTE: Realtime only works if the orders table has replication enabled in Supabase
    //    (Database → Replication → supabase_realtime publication → toggle orders ON).
    const channel = supabase
      .channel(`order-${order.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "orders", filter: `id=eq.${order.id}` },
        (payload) => applyUpdate(payload.new)
      )
      .subscribe();

    // 3. Always-on polling — 5s when the tab is visible (customer is watching),
    //    15s when hidden (background tab / phone screen off) to save battery.
    //    Guarantees updates even when Realtime replication is disabled on the table.
    let pollTimer = setInterval(() => fetchNow(0), document.visibilityState === "visible" ? 5000 : 15000);

    // 4. Re-fetch immediately when the customer switches back to this tab/app,
    //    and re-tune the polling interval for the new visibility state.
    const onVisible = () => {
      clearInterval(pollTimer);
      if (document.visibilityState === "visible") {
        fetchNow(0);
        pollTimer = setInterval(() => fetchNow(0), 5000);
      } else {
        pollTimer = setInterval(() => fetchNow(0), 15000);
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", onVisible);
      supabase.removeChannel(channel);
    };
  }, [order.id]);

  // Sync internal status when parent CustomerApp's auto-verify updates the prop.
  // (useState only initialises once, so prop changes after mount are ignored without this.)
  useEffect(() => {
    if (order.status && order.status !== status) {
      setStatus(order.status);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.status]);

  const submitRating = async (rating) => {
    setThumbSent(rating);
    if (SUPABASE_READY && order.id) {
      const { error } = await supabase.from("reviews").insert({ order_id: order.id, rating });
      if (error) {
        // Fix 11: don't pretend the review was saved when it wasn't
        console.warn("[bp] Review save failed:", error?.message);
        setThumbSent(null);
        setReviewDone(false);
        // Show the done state anyway for UX, but note the failure
        setThumbSent(rating + "_failed");
        setReviewDone(true);
        return;
      }
    }
    setReviewDone(true);
  };

  const steps  = getTrackerSteps(order.order_type || "dine-in");
  const curIdx = steps.findIndex(s => s.key === status);
  const ot     = order.order_type || "dine-in";

  // Items the customer asked to add via "Add More Items" that staff hasn't
  // approved yet — lives on the SAME order row (pending_addon_items), so
  // there's no separate order to reconcile. See finaliseOrder in the parent.
  const pendingAddon = (liveOrder.pending_addon_items && liveOrder.pending_addon_items.length > 0)
    ? liveOrder.pending_addon_items
    : null;

  // "Add More Items" visibility rules:
  // dine-in / takeaway → show as long as order isn't cancelled or done
  // delivery           → show only until rider is assigned (dispatched / served / cancelled = hide)
  const canAddMore = (() => {
    if (status === "cancelled" || status === "served" || status === "done") return false;
    if (ot === "delivery") return status === "pending" || status === "accepted";
    return true; // dine-in, takeaway
  })();

  const waitMins = (() => {
    if (status === "pending" || status === "accepted") {
      return waitTimes[ot] || (ot === "delivery" ? 40 : ot === "takeaway" ? 20 : 15);
    }
    return null;
  })();

  // Order was cancelled — creative animated sorry screen
  if (status === "cancelled") {
    const reason = liveOrder.cancel_reason || order.cancel_reason;
    const sadFoods = ["🍔","🍟","🍕","🌮","🧁","🍦","🥤","🍩"];
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center relative overflow-hidden"
        style={{ background: "linear-gradient(160deg, #1a1a2e 0%, #16213e 40%, #0f3460 100%)" }}>

        {/* Floating falling food emojis background */}
        <style>{`
          @keyframes floatDown {
            0%   { transform: translateY(-60px) rotate(0deg); opacity: 0; }
            10%  { opacity: 0.35; }
            90%  { opacity: 0.35; }
            100% { transform: translateY(110vh) rotate(360deg); opacity: 0; }
          }
          @keyframes sadBounce {
            0%, 100% { transform: translateY(0) scale(1); }
            30% { transform: translateY(-18px) scale(1.08); }
            60% { transform: translateY(-6px) scale(0.96); }
          }
          @keyframes glowPulse {
            0%, 100% { box-shadow: 0 0 30px rgba(239,68,68,0.4), 0 0 60px rgba(239,68,68,0.15); }
            50%       { box-shadow: 0 0 50px rgba(239,68,68,0.7), 0 0 90px rgba(239,68,68,0.3); }
          }
          @keyframes slideUpFade {
            from { opacity: 0; transform: translateY(28px); }
            to   { opacity: 1; transform: translateY(0); }
          }
          @keyframes wiggle {
            0%, 100% { transform: rotate(0deg); }
            20% { transform: rotate(-8deg); }
            40% { transform: rotate(8deg); }
            60% { transform: rotate(-5deg); }
            80% { transform: rotate(5deg); }
          }
          .cancel-slide-1 { animation: slideUpFade 0.5s 0.1s both ease-out; }
          .cancel-slide-2 { animation: slideUpFade 0.5s 0.3s both ease-out; }
          .cancel-slide-3 { animation: slideUpFade 0.5s 0.5s both ease-out; }
          .cancel-slide-4 { animation: slideUpFade 0.5s 0.7s both ease-out; }
          .cancel-slide-5 { animation: slideUpFade 0.5s 0.9s both ease-out; }
        `}</style>

        {/* Raining food emojis */}
        {sadFoods.map((emoji, i) => (
          <span key={i} className="fixed text-2xl select-none pointer-events-none" style={{
            left: `${8 + i * 12}%`,
            top: 0,
            animation: `floatDown ${4 + i * 0.7}s ${i * 0.6}s linear infinite`,
          }}>{emoji}</span>
        ))}

        {/* Big glowing sad burger icon */}
        <div className="cancel-slide-1 mb-6 relative">
          <div className="w-28 h-28 rounded-full bg-red-500/20 border-2 border-red-400/40 flex items-center justify-center text-6xl"
            style={{ animation: "sadBounce 2.5s ease-in-out infinite, glowPulse 2.5s ease-in-out infinite" }}>
            🍔
          </div>
          <div className="absolute -bottom-1 -right-1 w-10 h-10 rounded-full bg-red-500 flex items-center justify-center text-xl border-2 border-white/10"
            style={{ animation: "wiggle 1.8s ease-in-out infinite" }}>😢</div>
        </div>

        {/* Main copy */}
        <div className="cancel-slide-2 mb-2">
          <p className="text-4xl font-black text-white tracking-tight leading-tight">Aw, snap.</p>
          <p className="text-lg font-bold text-red-300 mt-1">This one slipped away.</p>
        </div>

        <p className="cancel-slide-3 text-sm text-white/60 max-w-[260px] mb-6 leading-relaxed">
          Your order had to be cancelled, but your next bite is just one tap away. We've saved your info — it'll be faster this time! 🚀
        </p>

        {/* Reason card */}
        {reason && (
          <div className="cancel-slide-3 w-full max-w-xs mb-4 rounded-2xl p-4 text-left"
            style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.12)" }}>
            <p className="text-[10px] font-bold text-red-400 uppercase tracking-widest mb-1.5">Why it happened</p>
            <p className="text-sm text-white/80">{reason}</p>
          </div>
        )}

        {/* Refund notice */}
        {order.payment_method && order.payment_method.toLowerCase().includes("razorpay") && (
          <div className="cancel-slide-3 w-full max-w-xs mb-5 rounded-2xl p-4 text-left"
            style={{ background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.3)" }}>
            <p className="text-xs font-bold text-blue-300 mb-1">💳 Your money is safe</p>
            <p className="text-xs text-blue-200/80">₹{order.total} will be refunded in 5–7 business days to your original payment method.</p>
            {order.razorpay_payment_id && <p className="text-[10px] font-mono text-blue-400/70 mt-1">Ref: {order.razorpay_payment_id}</p>}
          </div>
        )}

        {/* Order again CTA — big and bright */}
        <button onClick={onNewOrder}
          className="cancel-slide-4 w-full max-w-xs py-4 rounded-2xl font-black text-base text-white shadow-2xl active:scale-95 transition-transform mb-3"
          style={{ background: "linear-gradient(135deg, #f97316, #ef4444)", boxShadow: "0 8px 32px rgba(249,115,22,0.5)" }}>
          🛒 Build a new order →
        </button>

        <a href="tel:+919194008822"
          className="cancel-slide-5 flex items-center gap-2 text-white/50 font-semibold text-xs py-2 px-4 rounded-xl active:scale-95 transition-transform"
          style={{ border: "1px solid rgba(255,255,255,0.15)" }}>
          <Phone size={13} /> Call Restaurant
        </a>

        {/* Bottom tagline */}
        <p className="cancel-slide-5 mt-8 text-white/25 text-xs">Burger Point — good food is always worth the wait 🍔</p>
      </div>
    );
  }

  // Show the delivery map only for active delivery orders.
  // Guard against cancelled / served states slipping through (e.g. stale localStorage
  // on refresh before the fetch completes).
  const isDelivery = (liveOrder.order_type || order.order_type) === "delivery";
  if (isDelivery && status !== "cancelled" && status !== "served") {
    return (
      <Suspense fallback={
        <div className="fixed inset-0 bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center">
          <div className="text-center text-white">
            <div className="text-5xl mb-4">🛵</div>
            <p className="font-black text-xl">Loading Tracker…</p>
          </div>
        </div>
      }>
        <DeliveryTracker
          order={{ ...liveOrder, status }}
          riderName={riderName}
          riderPhone={riderPhone}
          restaurantCoords={[26.926287, 80.942995]}
          onNewOrder={onNewOrder}
        />
      </Suspense>
    );
  }

  // Feature 6: WhatsApp order summary
  const waOrderSummary = (() => {
    const lines = (liveOrder.items || order.items || []).map(it => `• ${it.name}${it.selectedVariant ? ` (${it.selectedVariant})` : ""} ×${it.qty} — ₹${it.finalPrice * it.qty}`);
    const msg = `🍔 *Burger Point Order*\n\n${lines.join("\n")}\n\n*Total: ₹${liveOrder.total ?? order.total}*`;
    const phone = order.customer_phone;
    return phone
      ? `https://wa.me/91${phone}?text=${encodeURIComponent(msg)}`
      : `https://wa.me/?text=${encodeURIComponent(msg)}`;
  })();

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 to-amber-50 flex flex-col">
      {/* Fix 15: delivery accepted >30 min with no rider assigned yet */}
      {isDeliveryStuck && (
        <div className="sticky top-0 z-20 bg-orange-500 text-white px-4 py-2.5 flex items-center justify-between gap-3">
          <span className="text-xs font-bold flex-1">Still finding a rider — taking longer than usual 🙏</span>
          <a href="tel:+919194008822" className="flex-shrink-0 bg-white/20 text-white text-xs font-black px-3 py-1.5 rounded-xl flex items-center gap-1.5">
            <Phone size={11} /> Call
          </a>
        </div>
      )}
      {/* Fix 5: pending >10 min escalation banner */}
      {isPendingStuck && status === "pending" && (
        <div className="sticky top-0 z-20 bg-red-500 text-white px-4 py-2.5 flex items-center justify-between gap-3">
          <span className="text-xs font-bold flex-1">Taking longer than expected — restaurant may have missed this order 🙏</span>
          <a href="tel:+919194008822" className="flex-shrink-0 bg-white/20 text-white text-xs font-black px-3 py-1.5 rounded-xl flex items-center gap-1.5">
            <Phone size={11} /> Call Now
          </a>
        </div>
      )}
      {/* Feature 1: stale banner */}
      {isStale && status === "accepted" && (
        <div className="sticky top-0 z-20 bg-yellow-400 text-yellow-900 px-4 py-2.5 flex items-center justify-between gap-3">
          <span className="text-xs font-bold flex-1">Still preparing — taking a little longer than usual 🙏</span>
          <a href="tel:+919194008822" className="flex-shrink-0 bg-yellow-900/20 text-yellow-900 text-xs font-black px-3 py-1.5 rounded-xl flex items-center gap-1.5">
            <Phone size={11} /> Call
          </a>
        </div>
      )}
      {/* Fix 7: kitchen busy banner */}
      {kitchenBusy && (status === "pending" || status === "accepted") && (
        <div className="bg-amber-100 border-b border-amber-300 text-amber-900 text-xs font-medium px-4 py-2 text-center">
          🍳 {kitchenBusy} — your order may take a bit longer than usual
        </div>
      )}
      {/* Feature 3: offline banner */}
      {isOffline && (
        <div className="bg-stone-700 text-white text-xs font-medium px-4 py-2 text-center">
          You're offline — status will update when you reconnect
        </div>
      )}
      <div className="bg-gradient-to-r from-orange-500 to-red-600 text-white px-5 pt-10 pb-8 flex-shrink-0">
        <div className="max-w-lg mx-auto">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-12 h-12 rounded-2xl bg-white/20 flex items-center justify-center text-2xl">{steps[curIdx]?.icon || "🕐"}</div>
            <div>
              <p className="font-black text-xl">{steps[curIdx]?.label || "Order Placed"}</p>
              <p className="text-orange-100 text-sm">{tableLabel || order.customer_name || "Your Order"} · ₹{order.total}</p>
            </div>
          </div>
          <div className="bg-white/20 rounded-2xl px-4 py-3 mb-2">
            <p className="text-orange-100 text-xs">{steps[curIdx]?.sub}</p>
          </div>
          {/* Feature 4: live ETA countdown */}
          {etaText && (
            <div className="bg-white/15 rounded-xl px-3 py-2 flex items-center gap-2">
              <Clock size={13} className="text-orange-200" />
              <span className="text-xs text-orange-100">
                {etaText === "Any moment now…"
                  ? <span className="font-bold text-white">Any moment now…</span>
                  : <>Estimated wait: <span className="font-bold text-white">{etaText}</span></>}
              </span>
            </div>
          )}
          {order.payment_method && (
            <div className="mt-2 bg-white/15 rounded-xl px-3 py-2 flex items-center gap-2">
              <span className="text-xs text-orange-100">💳 Paid via</span>
              <span className="text-xs font-bold text-white">{order.payment_method}</span>
              <span className="ml-auto text-xs bg-green-400/30 text-green-100 font-bold px-2 py-0.5 rounded-full">✓ Captured</span>
            </div>
          )}
          {order.promo_code && (
            <div className="mt-2 bg-white/15 rounded-xl px-3 py-2 flex items-center gap-2">
              <Tag size={12} className="text-orange-200" />
              <span className="text-xs text-orange-100">Promo <span className="font-bold text-white">{order.promo_code}</span> applied · saved ₹{order.discount}</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 px-5 py-6 max-w-lg mx-auto w-full">
        <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-5">Live Order Status</p>

        {/* Review nudge when served */}
        {status === "served" && (
          <div className="bg-gradient-to-br from-orange-50 to-yellow-50 border border-orange-200 rounded-2xl p-4 mb-5">
            {!thumbSent ? (
              <>
                <p className="text-sm font-bold text-stone-800 mb-3">How was your experience? 😊</p>
                <div className="flex gap-3 mb-3">
                  <button onClick={() => submitRating("up")} className="flex-1 flex items-center justify-center gap-2 bg-green-100 text-green-700 font-bold text-sm py-2.5 rounded-xl active:scale-95 transition-transform">
                    <ThumbsUp size={16} /> Loved it!
                  </button>
                  <button onClick={() => submitRating("down")} className="flex-1 flex items-center justify-center gap-2 bg-red-50 text-red-500 font-bold text-sm py-2.5 rounded-xl active:scale-95 transition-transform">
                    <ThumbsDown size={16} /> Not great
                  </button>
                </div>
                <a href={REVIEW_URL} target="_blank" rel="noreferrer"
                  className="flex items-center justify-center gap-1.5 text-xs text-orange-600 font-semibold">
                  <Star size={12} fill="currentColor" /> Leave a Google Review ⭐
                </a>
              </>
            ) : (
              <div className="text-center">
                {thumbSent.includes("_failed") ? (
                  <>
                    <p className="text-2xl mb-1">🙏</p>
                    <p className="text-sm font-bold text-stone-800">Thanks! (Couldn't save — please leave a Google review instead)</p>
                    <a href={REVIEW_URL} target="_blank" rel="noreferrer"
                      className="mt-2 inline-flex items-center gap-1 text-xs text-orange-600 font-semibold">
                      <Star size={11} fill="currentColor" /> Review on Google
                    </a>
                  </>
                ) : (
                  <>
                    <p className="text-2xl mb-1">{thumbSent === "up" ? "🎉" : "🙏"}</p>
                    <p className="text-sm font-bold text-stone-800">{thumbSent === "up" ? "Thanks! We're glad you loved it!" : "Thanks for the feedback. We'll improve!"}</p>
                    {thumbSent === "up" && (
                      <a href={REVIEW_URL} target="_blank" rel="noreferrer"
                        className="mt-2 inline-flex items-center gap-1 text-xs text-orange-600 font-semibold">
                        <Star size={11} fill="currentColor" /> Share on Google too?
                      </a>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Rider info */}
        {ot === "delivery" && status === "dispatched" && riderName && (
          <div className="bg-purple-50 border border-purple-200 rounded-2xl p-4 mb-5">
            <p className="text-xs font-bold text-purple-800 mb-2 flex items-center gap-1.5"><Bike size={13} /> Your Delivery Rider</p>
            <div className="flex items-center justify-between">
              <div><p className="font-bold text-stone-800">{riderName}</p>{riderPhone && <p className="text-sm text-stone-500">{riderPhone}</p>}</div>
            </div>
            {/* Feature 5: rider call + WA buttons */}
            {riderPhone && (
              <div className="flex gap-2 mt-3">
                <a href={`tel:${riderPhone}`} className="flex-1 flex items-center justify-center gap-1.5 bg-green-500 text-white text-xs font-bold py-2.5 rounded-xl shadow-sm">
                  📞 Call Rider
                </a>
                <a href={`https://wa.me/91${riderPhone}?text=${encodeURIComponent("Hi, I'm waiting for my Burger Point order. Can you share your ETA?")}`}
                  target="_blank" rel="noreferrer"
                  className="flex-1 flex items-center justify-center gap-1.5 bg-green-100 text-green-800 text-xs font-bold py-2.5 rounded-xl shadow-sm">
                  💬 WhatsApp Rider
                </a>
              </div>
            )}
          </div>
        )}

        {/* 🎮 Mini-game panel — visible while order is being prepared */}
        {(status === "accepted" || status === "pending") && (
          <div className="rounded-3xl mb-6 overflow-hidden" style={{ background: "linear-gradient(160deg,#1a1a2e,#0f3460)", border: "1.5px solid rgba(249,115,22,0.3)" }}>
            <button
              onClick={() => setGamesOpen(o => !o)}
              className="w-full px-4 pt-4 pb-3 flex items-center justify-between active:opacity-80 transition-opacity">
              <div className="text-left">
                <p className="text-xs font-black text-orange-400 uppercase tracking-widest">While you wait</p>
                <p className="text-sm font-bold text-white mt-0.5">
                  {status === "accepted" ? "Kitchen's on it — play a quick game! 🎮" : "Waiting for kitchen — keep yourself busy 🍿"}
                </p>
              </div>
              <span className="text-xs font-bold text-white/50 ml-3 flex-shrink-0">
                {gamesOpen ? "▲ Hide" : "▼ Show"}
              </span>
            </button>
            {gamesOpen && (
              <div className="px-4 pb-4 pt-1">
                <WaitingGames />
              </div>
            )}
          </div>
        )}

        {/* ── Add More Items (moved above the live status tracker) ── */}
        {canAddMore && !pendingAddon && (
          <div className="mb-5">
            <button
              onClick={onNewOrder}
              className="w-full bg-gradient-to-r from-orange-500 to-red-500 text-white py-4 rounded-2xl font-bold text-sm shadow-lg active:scale-95 transition-transform flex items-center justify-center gap-2"
            >
              <span className="text-lg">➕</span>
              Add More Items
            </button>
            <p className="text-center text-[10px] text-stone-400 mt-2">
              {ot === "dine-in"
                ? "Craving something else? Add to your table — kitchen gets notified instantly."
                : "Want to add to your order? Place it now before it's packed."}
            </p>
          </div>
        )}

        {/* ── Pending add-on request — waiting for staff to approve ── */}
        {pendingAddon && (
          <div className="mb-5 bg-amber-50 border-2 border-amber-300 rounded-2xl p-4">
            <p className="text-xs font-black text-amber-700 flex items-center gap-1.5">
              ⏳ Waiting for approval
            </p>
            <p className="text-[11px] text-amber-600 mt-1 mb-2">
              You asked to add these to your {ot === "dine-in" ? "table's" : ""} order — staff will confirm in a moment:
            </p>
            {pendingAddon.map((it, i) => (
              <div key={i} className="flex justify-between text-sm py-0.5">
                <span className="text-stone-700">{it.name}{it.selectedVariant ? ` (${it.selectedVariant})` : ""} ×{it.qty}</span>
                <span className="text-stone-500 font-semibold">₹{it.finalPrice * it.qty}</span>
              </div>
            ))}
            <p className="text-[10px] text-amber-500 mt-2">Once approved, it'll appear below with the rest of your order — and on one bill.</p>
          </div>
        )}

        {/* Steps */}
        {steps.map(({ key, label, sub, icon }, i) => {
          const done = i <= curIdx; const cur = i === curIdx;
          return (
            <div key={key} className="flex items-start gap-4 mb-6 relative">
              {i < steps.length - 1 && <div className={`absolute left-[19px] top-11 w-0.5 h-8 transition-all duration-700 ${done && i < curIdx ? "bg-orange-400" : "bg-stone-200"}`} />}
              <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 text-lg transition-all duration-500 ${done ? "bg-orange-500 shadow-md" : "bg-stone-200"} ${cur ? "ring-4 ring-orange-200" : ""}`}>
                {done ? <span>{icon}</span> : <span className="text-stone-400 text-sm">{i + 1}</span>}
              </div>
              <div className="flex-1 pt-1.5">
                <p className={`text-sm font-bold ${done ? "text-stone-800" : "text-stone-300"}`}>{label}</p>
                <p className={`text-xs mt-0.5 ${done ? "text-stone-500" : "text-stone-300"}`}>{sub}</p>
              </div>
              {cur && status !== "served" && (
                <span className="flex items-center gap-1 text-[10px] font-bold text-orange-500 mt-2 bg-orange-50 px-2 py-1 rounded-lg">
                  <span className="w-1.5 h-1.5 bg-orange-500 rounded-full animate-pulse" /> LIVE
                </span>
              )}
            </div>
          );
        })}

        {/* Order summary — live: reflects any approved add-ons instantly */}
        <div className="bg-white rounded-2xl p-4 border border-orange-100 mt-2">
          <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-3">Your Order</p>
          {(liveOrder.items || order.items)?.map((it, i) => (
            <div key={i} className="flex justify-between text-sm py-1">
              <span className="text-stone-700">{it.name}{it.selectedVariant ? ` (${it.selectedVariant})` : ""} ×{it.qty}
                {it.addonLabels?.length > 0 && <span className="text-[11px] text-orange-400 ml-1">({it.addonLabels.join(", ")})</span>}
              </span>
              <span className="text-stone-500 font-semibold">₹{it.finalPrice * it.qty}</span>
            </div>
          ))}
          <div className="border-t border-stone-100 pt-2 mt-2 flex justify-between font-bold text-sm">
            <span>Total</span><span className="text-orange-600">₹{liveOrder.total ?? order.total}</span>
          </div>
          {order.note && <p className="text-xs text-stone-400 italic mt-2">Note: "{order.note}"</p>}
        </div>

        {/* Feature 6 + Fix 12: WhatsApp order summary with clipboard fallback for desktop */}
        <button
          onClick={async () => {
            const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
            if (isMobile) { window.open(waOrderSummary, "_blank", "noreferrer"); return; }
            // Desktop: extract the text part and copy it
            try {
              const msg = decodeURIComponent(waOrderSummary.split("text=")[1] || "");
              await navigator.clipboard.writeText(msg);
              alert("Order summary copied! Open WhatsApp on your phone and paste it.");
            } catch { window.open(waOrderSummary, "_blank", "noreferrer"); }
          }}
          className="mt-3 w-full flex items-center justify-center gap-2 border border-green-200 text-green-700 font-bold text-sm py-3 rounded-2xl active:scale-95 transition-transform bg-green-50">
          📲 Send to WhatsApp
        </button>

        <a href="tel:+919194008822" className="mt-3 w-full flex items-center justify-center gap-2 border border-orange-200 text-orange-600 font-bold text-sm py-3 rounded-2xl active:scale-95 transition-transform">
          <Phone size={15} /> Call Restaurant
        </a>

        {/* After served — start a fresh order */}
        {status === "served" && (
          <button onClick={onNewOrder} className="mt-3 w-full border-2 border-orange-400 text-orange-600 py-3.5 rounded-2xl font-bold text-sm active:scale-95 transition-transform">
            🛒 New Order
          </button>
        )}
        <div className="mt-4 flex gap-3 justify-center">
          <button onClick={() => window.location.hash = "privacy"} className="text-xs text-stone-400 underline">Privacy Policy</button>
          <button onClick={() => window.location.hash = "contact"} className="text-xs text-stone-400 underline">Contact Us</button>
        </div>
      </div>
    </div>
  );
}

// ── ORDER HISTORY MODAL ───────────────────────────────────
function OrderHistoryModal({ onClose, onReorder, onShareReceipt }) {
  const history = (() => { try { return JSON.parse(localStorage.getItem(LS_HISTORY) || "[]"); } catch { return []; } })();
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full bg-white rounded-t-3xl max-w-xl mx-auto flex flex-col" style={{ maxHeight: "85vh" }} onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 bg-stone-200 rounded-full mx-auto mt-3 flex-shrink-0" />
        <div className="flex items-center justify-between px-5 pt-3 pb-3 border-b border-stone-100 flex-shrink-0">
          <h3 className="font-bold text-stone-800 text-base flex items-center gap-2"><History size={16} className="text-orange-500" /> My Orders</h3>
          <button onClick={onClose} className="w-7 h-7 rounded-full bg-stone-100 flex items-center justify-center"><X size={14} className="text-stone-500" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {history.length === 0 ? (
            <div className="text-center py-12"><p className="text-4xl mb-2">📋</p><p className="text-stone-400 text-sm font-medium">No past orders yet</p></div>
          ) : history.map((order, i) => (
            <div key={i} className="bg-stone-50 rounded-2xl p-4 mb-3 border border-stone-100">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <p className="text-xs font-bold text-stone-700">{order.table_label || order.customer_name || "Order"}</p>
                  <p className="text-[11px] text-stone-400">{new Date(order.created_at || Date.now()).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</p>
                </div>
                <span className="text-sm font-black text-orange-600">₹{order.total}</span>
              </div>
              <div className="text-xs text-stone-500 mb-3">
                {order.items?.slice(0, 3).map((it, j) => (
                  <span key={j}>{it.name} ×{it.qty}{j < Math.min(order.items.length, 3) - 1 ? ", " : ""}</span>
                ))}
                {order.items?.length > 3 && <span className="text-stone-400"> +{order.items.length - 3} more</span>}
              </div>
              <div className="flex gap-2">
                <button onClick={() => { onReorder(order.items); onClose(); }}
                  className="flex items-center gap-1.5 bg-orange-50 border border-orange-200 text-orange-600 text-xs font-bold px-3 py-2 rounded-xl active:scale-95 transition-transform">
                  <RefreshCw size={11} /> Reorder
                </button>
                {/* Fix 8: save receipt */}
                <button onClick={() => onShareReceipt(order)}
                  className="flex items-center gap-1.5 bg-stone-100 border border-stone-200 text-stone-600 text-xs font-bold px-3 py-2 rounded-xl active:scale-95 transition-transform">
                  <Share2 size={11} /> Receipt
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── COMBO UPSELL MAP ─────────────────────────────────────
// Maps item name keywords to combo IDs so we can suggest combos when cart matches
const COMBO_MAP = [
  {
    comboId: "8867014d-8f23-4caf-8ad7-8f955e2649ab", // Aloo Tikki Burger Combo ₹134
    keywords: ["Aloo Tikki Burger", "French Fries", "Cold Drink"],
  },
  {
    comboId: "3d1e388f-8c56-499c-8985-182f3be7f351", // Mega Munch ₹249
    keywords: ["Supreme Tikki Burger", "French Fries", "Cold Coffee"],
  },
  {
    comboId: "38c9cae6-6a94-405a-9dfd-d68edde9cb7f", // Pizza Combo ₹205
    keywords: ["Margherita Pizza", "French Fries", "Cold Drink"],
  },
  {
    comboId: "3a58c87a-35ba-48dc-883f-2287451f990d", // Coffee & Sandwich Combo ₹143
    keywords: ["Hot Coffee", "Veg Cheese Sandwich"],
  },
  {
    comboId: "be7a3e78-0169-452f-8b33-da1d457d5328", // Burger + Pizza Mega Combo ₹314
    keywords: ["Supreme Tikki Burger", "Margherita Pizza", "French Fries"],
  },
  {
    comboId: "8e7ca558-3848-4786-9a9d-0c8b08460c31", // Snack Attack Platter ₹299
    keywords: ["Veg Noodles", "Chilli Potato", "Spring Roll", "Veg Momo"],
  },
  {
    comboId: "6c9951fc-b8f4-4679-b862-fb6251f9a218", // Triple Treat ₹269
    keywords: ["Veg Maggi", "Oreo Shake", "Peri Peri Fries"],
  },
];

function useComboSuggestions(cart, menu) {
  return useMemo(() => {
    if (!cart || cart.length === 0) return [];
    const allItems = Object.values(menu).flat();
    const cartNames = cart.map(c => c.name.toLowerCase());
    const suggestions = [];
    for (const { comboId, keywords } of COMBO_MAP) {
      const matchCount = keywords.filter(kw =>
        cartNames.some(n => n.includes(kw.toLowerCase()))
      ).length;
      if (matchCount >= 1) {
        const comboItem = allItems.find(i => i.id === comboId);
        if (comboItem && !cart.some(c => c.id === comboId)) {
          // Calculate how much customer would save
          const cartTotal = cart.reduce((s, c) => s + c.finalPrice * c.qty, 0);
          suggestions.push({ combo: comboItem, matchCount, cartTotal });
        }
      }
    }
    // Sort by match count descending
    return suggestions.sort((a, b) => b.matchCount - a.matchCount).slice(0, 2);
  }, [cart, menu]);
}

// ── TODAY'S SPECIAL HOOK ─────────────────────────────────
// Picks one item per day from bestsellers, rotating daily.
// Same item shows all day for consistency.
function useTodaySpecial(menu, bestsellers, specialItemId) {
  return useMemo(() => {
    const all = Object.values(menu).flat();
    // If admin has pinned a specific item, use it (if it's still available)
    if (specialItemId) {
      const pinned = all.find(i => i.id === specialItemId && i.is_available !== false);
      if (pinned) return pinned;
      // Pinned item unavailable — fall through to auto-rotate below
    }
    const bsItems = all.filter(i => bestsellers.has(i.id) && i.is_available !== false);
    if (bsItems.length === 0) return null;
    // Use day-of-year as seed so it changes daily but stays same all day
    const now = new Date();
    const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86_400_000);
    return bsItems[dayOfYear % bsItems.length];
  }, [menu, bestsellers, specialItemId]);
}

// ── PROMO BANNER POPUP ──────────────────────────────────────────────────────
// Full-screen on first open (dismissed per session via sessionStorage).
// Also exported as a small inline block for use in CartDrawer.
const SS_BANNER_DISMISSED = "bp_banner_dismissed";

function PromoBannerPopup({ url, onDismiss }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => { setTimeout(() => setVisible(true), 120); }, []);
  const dismiss = () => { setVisible(false); setTimeout(onDismiss, 300); };
  return (
    <div
      className={`fixed inset-0 z-[999] flex flex-col items-center justify-center transition-all duration-300
        ${visible ? "bg-black/75 backdrop-blur-sm" : "bg-black/0 pointer-events-none"}`}
      onClick={dismiss}>
      <div
        className={`relative w-full max-w-sm mx-4 rounded-3xl overflow-hidden shadow-2xl transition-all duration-300
          ${visible ? "scale-100 opacity-100" : "scale-90 opacity-0"}`}
        onClick={e => e.stopPropagation()}>
        <img src={url} alt="Promotion" className="w-full object-cover" />
        {/* Tap anywhere outside or X to dismiss */}
        <button onClick={dismiss}
          className="absolute top-3 right-3 w-8 h-8 bg-black/60 text-white rounded-full text-sm font-black flex items-center justify-center shadow-lg">
          ✕
        </button>
        <button onClick={dismiss}
          className="w-full bg-orange-500 text-white font-black text-sm py-3.5 tracking-wide">
          Order Now →
        </button>
      </div>
    </div>
  );
}

// Small inline banner block shown in the cart
function PromoBannerBlock({ url }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className="relative rounded-2xl overflow-hidden shadow-sm border border-orange-100 mb-3">
      <img src={url} alt="Promotion" className="w-full object-cover max-h-36" />
      <button onClick={() => setDismissed(true)}
        className="absolute top-2 right-2 w-6 h-6 bg-black/50 text-white rounded-full text-[10px] font-black flex items-center justify-center">
        ✕
      </button>
    </div>
  );
}

function useBestsellers(menu) {
  const [bestsellers, setBestsellers] = useState(() => {
    try {
      const cached = JSON.parse(lsGet(LS_BESTSELLERS, "null"));
      if (cached && Date.now() - cached.ts < 3_600_000) return new Set(cached.ids);
    } catch {}
    return new Set();
  });

  useEffect(() => {
    if (!SUPABASE_READY) return;
    const ALL = Object.values(menu).flat();
    const run = async () => {
      // 1. Manual pins from DB
      const { data: manual } = await supabase.from("menu_items")
        .select("id").eq("is_bestseller_manual", true);
      const manualIds = new Set((manual || []).map(i => i.id));

      // 2. Auto-calculate from served orders (last 30 days)
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const { data: served } = await supabase.from("orders")
        .select("items").eq("status", "served").gte("created_at", since);

      const counts = {};
      (served || []).forEach(o =>
        (Array.isArray(o.items) ? o.items : []).forEach(it => {
          counts[it.name] = (counts[it.name] || 0) + (it.qty || 1);
        })
      );
      const topNames = Object.entries(counts)
        .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n]) => n);
      const autoIds = topNames
        .map(name => ALL.find(i => i.name === name)?.id).filter(Boolean);

      // Manual takes priority; merge both sets
      const finalIds = new Set([...manualIds, ...autoIds]);
      setBestsellers(finalIds);
      lsSet(LS_BESTSELLERS, JSON.stringify({ ids: [...finalIds], ts: Date.now() }));
    };
    run();
  }, [menu]);

  return bestsellers;
}

// ── CHECKOUT INFO SHEET ───────────────────────────────────
// Bottom sheet shown at order time — collects name/phone (and address for delivery).
// Pre-fills from saved data so returning customers just tap confirm.

function CheckoutInfoSheet({ orderType, existing, onSubmit, onClose }) {
  const [name,     setName]     = useState(existing?.name    || "");
  const [phone,    setPhone]    = useState(existing?.phone   || "");
  const [house,    setHouse]    = useState("");
  const [street,   setStreet]   = useState("");
  const [landmark, setLandmark] = useState("");
  const [coords,   setCoords]   = useState(null);
  const [locating, setLocating] = useState(false);
  const [err,      setErr]      = useState("");
  const { settings } = useBusinessSettings();
  const { addresses: savedAddrs, save: saveAddr, remove: removeAddr } = useSavedAddresses();
  const toast = useToast();

  // Pre-fill address fields if existing delivery address
  useEffect(() => {
    if (existing?.address && orderType === "delivery") {
      // parse first part as house, rest as street — best-effort
      const parts = existing.address.split(", ");
      setHouse(parts[0] || "");
      setStreet(parts[1] || "");
    }
    if (existing?.lat && existing?.lng) setCoords({ lat: existing.lat, lng: existing.lng });
  }, []);

  const useMyLocation = () => {
    if (!navigator.geolocation) { setErr("Location not supported on this browser."); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        setCoords({ lat, lng });
        toast.success("Location captured ✓");
        setLocating(false);
      },
      () => { setLocating(false); setErr("Couldn't get location — please allow access and try again."); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const buildAddress = () => [house.trim(), street.trim(), landmark.trim() ? `Near ${landmark.trim()}` : "", "Lucknow"].filter(Boolean).join(", ");

  const applySaved = (a) => {
    setHouse(a.house || ""); setStreet(a.street || ""); setLandmark(a.landmark || "");
    if (a.lat && a.lng) setCoords({ lat: a.lat, lng: a.lng });
    toast.info("Address loaded");
  };

  const submit = () => {
    if (!name.trim())             { setErr("Please enter your name."); return; }
    if (!/^\d{10}$/.test(phone))  { setErr("Enter a valid 10-digit phone number."); return; }
    // Live location is mandatory for delivery only — dine-in is location-verified
    // via the table code, and takeaway customers are coming to the restaurant anyway.
    if (orderType === "delivery" && (!coords?.lat || !coords?.lng)) {
      setErr("Please share your location — tap 'Use my location' below to continue.");
      return;
    }
    if (orderType === "delivery") {
      if (!house.trim())  { setErr("Please enter house/flat number."); return; }
      if (!street.trim()) { setErr("Please enter street / colony."); return; }
      const full = buildAddress();
      if (full.length > 5) saveAddr({ label: house.trim().slice(0, 30), house: house.trim(), street: street.trim(), landmark: landmark.trim(), lat: coords?.lat ?? null, lng: coords?.lng ?? null, fullAddress: full });
    }
    onSubmit({ name: name.trim(), phone, address: orderType === "delivery" ? buildAddress() : null, lat: orderType === "delivery" ? (coords?.lat ?? null) : null, lng: orderType === "delivery" ? (coords?.lng ?? null) : null });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg mx-auto bg-white rounded-t-3xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-white px-5 pt-5 pb-3 border-b border-stone-100 z-10">
          <div className="w-10 h-1 bg-stone-200 rounded-full mx-auto mb-4" />
          <div className="flex items-center justify-between">
            <div>
              <p className="font-black text-stone-800 text-lg">{orderType === "delivery" ? "🛵 Delivery Details" : "📦 Your Details"}</p>
              <p className="text-xs text-stone-400 mt-0.5">Quick checkout — saved for next time</p>
            </div>
            <button onClick={onClose} className="w-8 h-8 rounded-xl bg-stone-100 flex items-center justify-center"><X size={14} className="text-stone-500" /></button>
          </div>
        </div>

        <div className="p-5 space-y-3">
          {/* Name */}
          <div>
            <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Your Name *</label>
            <div className="relative">
              <User size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
              <input value={name} onChange={e => { setName(e.target.value); setErr(""); }} placeholder="e.g. Rahul Sharma"
                className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-2xl pl-9 pr-4 py-3 outline-none transition-colors" />
            </div>
          </div>
          {/* Phone */}
          <div>
            <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Phone Number *</label>
            <div className="relative">
              <Phone size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
              <input value={phone} onChange={e => { setPhone(e.target.value.replace(/\D/g, "").slice(0, 10)); setErr(""); }} placeholder="10-digit mobile" inputMode="numeric"
                className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-2xl pl-9 pr-4 py-3 outline-none transition-colors" />
            </div>
          </div>

          {/* Live location — required for delivery only */}
          {orderType === "delivery" && (
            <div className="space-y-2">
              <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest flex items-center gap-1">
                <MapPin size={9} /> Your Location <span className="text-red-500">*</span>
              </p>

              {coords?.lat && coords?.lng ? (
                <div className="bg-green-50 border border-green-200 rounded-xl px-3 py-2.5 flex items-center gap-2">
                  <CheckCircle size={14} className="text-green-600 flex-shrink-0" />
                  <span className="text-xs font-bold text-green-700">Location confirmed ✓</span>
                </div>
              ) : (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-700">
                  We need your live location to {orderType === "delivery" ? "calculate delivery distance and fee" : "confirm you're nearby for pickup"}. Orders can't be placed without it.
                </div>
              )}

              <button type="button" onClick={useMyLocation} disabled={locating}
                className="w-full flex items-center justify-center gap-1.5 text-xs font-bold text-orange-600 bg-orange-50 border border-orange-200 rounded-xl py-2.5 disabled:opacity-60">
                <Navigation size={13} /> {locating ? "Locating…" : coords?.lat ? "Re-share location" : "Use my location"}
              </button>
            </div>
          )}

          {/* Delivery address */}
          {orderType === "delivery" && (
            <div className="space-y-2">
              <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest flex items-center gap-1"><MapPin size={9} /> Delivery Address</p>

              {/* Saved addresses */}
              <SavedAddressPicker addresses={savedAddrs} onSelect={applySaved} onRemove={removeAddr} />

              <div className="bg-orange-50 border border-orange-100 rounded-2xl p-3 space-y-2">
                <div>
                  <label className="text-[10px] font-semibold text-stone-500 block mb-1">🏠 House / Flat / Shop No. *</label>
                  <input value={house} onChange={e => { setHouse(e.target.value); setErr(""); }} placeholder="e.g. H-42, Flat 3B"
                    className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2.5 outline-none bg-white" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-stone-500 block mb-1">🛣️ Street / Colony *</label>
                  <input value={street} onChange={e => { setStreet(e.target.value); setErr(""); }} placeholder="e.g. Sector C, Jankipuram"
                    className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2.5 outline-none bg-white" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-stone-500 block mb-1">📍 Landmark <span className="font-normal text-stone-400">(optional)</span></label>
                  <input value={landmark} onChange={e => { setLandmark(e.target.value); setErr(""); }} placeholder="e.g. Near City Hospital"
                    className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2.5 outline-none bg-white" />
                </div>
              </div>

              {(house || street) && (
                <div className="bg-green-50 border border-green-100 rounded-xl px-3 py-2">
                  <p className="text-[10px] font-bold text-green-600 mb-0.5">📋 Address Preview</p>
                  <p className="text-xs text-stone-600">{buildAddress()}</p>
                </div>
              )}
            </div>
          )}

          {err && <p className="text-red-500 text-xs font-medium text-center">{err}</p>}

          <button onClick={submit}
            disabled={orderType === "delivery" && !(coords?.lat && coords?.lng)}
            className="w-full bg-gradient-to-r from-orange-500 to-red-500 text-white py-4 rounded-2xl font-bold text-sm shadow-md active:scale-95 transition-transform mt-2 disabled:opacity-40 disabled:pointer-events-none">
            {existing?.name ? "✅ Confirm & Continue" : orderType === "delivery" ? "🛵 Save & Continue" : "📦 Save & Continue"}
          </button>
        </div>
      </div>

    </div>
  );
}


// ── Web Push Subscription Hook ────────────────────────────
// Handles subscribing customers to push notifications.
// Shows a soft prompt banner first (user gesture required by browsers),
// then triggers the real OS permission dialog only on explicit tap.
const LS_PUSH_DISMISSED = "bp_push_dismissed";

function usePushSubscription() {
  const [banner, setBanner] = useState(false);
  const [subbed,  setSubbed]  = useState(false);

  useEffect(() => {
    if (!SUPABASE_READY) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (!import.meta.env.VITE_VAPID_PUBLIC_KEY) return;

    // Already subscribed or previously dismissed — don't show banner
    if (lsGet(LS_PUSH_DISMISSED)) return;
    if (Notification.permission === "denied") return;

    // If already granted, silently subscribe without showing banner
    if (Notification.permission === "granted") {
      subscribeSilently();
      return;
    }

    // Show soft prompt after 4 seconds — gives user time to see the app first
    const t = setTimeout(() => setBanner(true), 4000);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function subscribeSilently() {
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
        const raw = Uint8Array.from(
          atob(vapidKey.replace(/-/g, "+").replace(/_/g, "/")),
          c => c.charCodeAt(0)
        );
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
      }
      const subJson = sub.toJSON();
      await supabase.from("push_subscriptions").upsert({
        endpoint: subJson.endpoint,
        p256dh:   subJson.keys?.p256dh,
        auth:     subJson.keys?.auth,
        role:     "customer",
      }, { onConflict: "endpoint" });
      setSubbed(true);
    } catch (e) {
      // push subscription failed — non-critical
    }
  }

  const allow = async () => {
    setBanner(false);
    lsSet(LS_PUSH_DISMISSED, "1"); // don't re-prompt regardless of outcome
    const permission = await Notification.requestPermission();
    if (permission === "granted") await subscribeSilently();
  };

  const dismiss = () => {
    setBanner(false);
    lsSet(LS_PUSH_DISMISSED, "1");
  };

  return { banner, subbed, allow, dismiss };
}

// ── Push Permission Banner ────────────────────────────────
function PushBanner({ onAllow, onDismiss }) {
  return (
    <div className="fixed bottom-20 left-3 right-3 z-50 max-w-sm mx-auto">
      <div className="bg-stone-900 text-white rounded-2xl px-4 py-3.5 shadow-2xl flex items-start gap-3 animate-[slideUp_0.3s_ease-out]">
        <span className="text-2xl flex-shrink-0 mt-0.5">🔔</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold leading-tight">Stay updated on your order</p>
          <p className="text-xs text-stone-400 mt-0.5 leading-snug">Get notified when your food is ready — even when the app is closed.</p>
          <div className="flex gap-2 mt-2.5">
            <button onClick={onAllow}
              className="flex-1 bg-orange-500 text-white text-xs font-bold py-1.5 rounded-xl active:scale-95 transition-transform">
              Allow
            </button>
            <button onClick={onDismiss}
              className="flex-1 bg-stone-700 text-stone-300 text-xs font-bold py-1.5 rounded-xl active:scale-95 transition-transform">
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── CUSTOMER APP ──────────────────────────────────────────
// Cart persistence — module-level so they're never recreated on render
const LS_CART  = "bp_cart_v2";
const CART_TTL = 2 * 60 * 60 * 1000; // 2 hours

export function CustomerApp({ code, tableLabel, orderType = "dine-in" }) {
  const [activeCat,     setActiveCat]     = useState("burgers");
  const [search,        setSearch]        = useState("");
  const [cart, setCart] = useState(() => {
    try {
      const raw = lsGet(LS_CART);
      if (!raw) return [];
      const { items, ts } = JSON.parse(raw);
      if (Date.now() - ts > CART_TTL) { lsRemove(LS_CART); return []; }
      return items || [];
    } catch { return []; }
  });
  useEffect(() => {
    lsSet(LS_CART, JSON.stringify({ items: cart, ts: Date.now() }));
  }, [cart]);
  const [showCart,      setShowCart]      = useState(false);
  const [itemModal,     setItemModal]     = useState(null);

  // ── Customer info — persisted in localStorage ────────────
  const [customerInfo, setCustomerInfoState] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_CUSTOMER) || "null"); } catch { return null; }
  });
  const [showInfoModal, setShowInfoModal] = useState(false);
  const saveCustomerInfo = (info) => {
    // Save everything — name, phone, address, coords
    const toSave = {
      name:    info.name,
      phone:   info.phone,
      address: info.address || null,
      lat:     info.lat    || null,
      lng:     info.lng    || null,
    };
    localStorage.setItem(LS_CUSTOMER, JSON.stringify(toSave));
    setCustomerInfoState({ ...toSave });
  };
  const [placed, setPlaced] = useState(() => {
    try {
      const ss = sessionStorage.getItem(SS_ORDER);
      if (ss) return JSON.parse(ss);
      // Resume across browser close
      const ls = JSON.parse(lsGet(LS_ACTIVE_ORDER, "null"));
      if (ls && ACTIVE_STATUSES.has(ls.status)) return ls;
      if (ls) lsRemove(LS_ACTIVE_ORDER); // stale served order
    } catch {}
    return null;
  });
  const [placing,       setPlacing]       = useState(false);
  const [showRazorpay,  setShowRazorpay]  = useState(null);
  const [showHistory,   setShowHistory]   = useState(false);
  const [menu,          setMenu]          = useState({});
  const [dbCategories,  setDbCategories]  = useState(null); // null = not loaded yet
  const { settings: bizSettings } = useBusinessSettings();
  const [favs,          setFavs]          = useState(() => { try { return JSON.parse(localStorage.getItem(LS_FAVS) || "[]"); } catch { return []; } });
  const [showFavs,      setShowFavs]      = useState(false);
  const catBarRef      = useRef(null);
  const menuAreaRef    = useRef(null);
  const lastScrollY    = useRef(0);
  const catSectionRefs = useRef({});

  // Collapse bestseller section on scroll down, expand on scroll up
  useEffect(() => {
    const el = menuAreaRef.current;
    if (!el) return;
    const onScroll = () => {
      const y = el.scrollTop;
      if (y > lastScrollY.current + 40) { setBsCollapsed(true); }
      else if (y < lastScrollY.current - 20) { setBsCollapsed(false); }
      lastScrollY.current = y;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  const [menuLoaded,   setMenuLoaded]   = useState(false);
  const [cartBouncing, setCartBouncing] = useState(false);
  const toast = useToast();

  // Ref so the realtime unavailability handler always sees the latest cart
  // without needing cart in its dependency array (which would re-subscribe on every change)
  const cartRef = useRef(cart);
  useEffect(() => { cartRef.current = cart; }, [cart]);

  const bestsellers = useBestsellers(menu);
  const todaySpecial = useTodaySpecial(menu, bestsellers, bizSettings.special_item_id);

  // Promo banner — show full-screen popup once per session if enabled + has image
  const [bannerDismissed, setBannerDismissed] = useState(
    () => !!sessionStorage.getItem(SS_BANNER_DISMISSED)
  );
  const showBannerPopup = bizSettings.promo_banner_enabled && bizSettings.promo_banner_url && !bannerDismissed && !placed;
  const dismissBanner = () => { sessionStorage.setItem(SS_BANNER_DISMISSED, "1"); setBannerDismissed(true); };
  const [bsCollapsed, setBsCollapsed] = useState(false);
  const { banner: pushBanner, allow: pushAllow, dismiss: pushDismiss } = usePushSubscription();

  // Feature 8: real-time cart unavailability
  const [unavailableCartIds, setUnavailableCartIds] = useState(new Set());
  useEffect(() => {
    if (!SUPABASE_READY) return;
    const channel = supabase.channel("menu-items-avail")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "menu_items" }, (payload) => {
        const item = payload.new;
        if (item.is_available === false) {
          // Use cartRef so we always see the current cart, not the mount-time snapshot
          const cartIds = cartRef.current.map(c => c.id);
          if (cartIds.includes(item.id)) {
            setUnavailableCartIds(prev => new Set([...prev, item.id]));
          }
        } else {
          setUnavailableCartIds(prev => { const n = new Set(prev); n.delete(item.id); return n; });
        }
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  // Auto-verify resumed order status on mount.
  // Only runs for orders older than 2 minutes. Fresh orders (just placed)
  // cannot be ghost orders — the insert either succeeded (we would see the
  // tracker) or failed (the error screen would have shown). More importantly,
  // Supabase/PostgREST has a brief propagation delay before a freshly-inserted
  // row is readable via SELECT, so running this immediately after insert gives
  // false-positive PGRST116 errors that nuke perfectly real orders.
  // The tracker's own 10-second polling handles status sync for fresh orders.
  useEffect(() => {
    if (!placed || !SUPABASE_READY) return;

    // Run immediately on mount — syncs status and catches ghost orders.
    // maybeSingle() returns { data: null, error: null } when no rows match
    // (avoids PGRST116 errors from .single() on missing rows).
    supabase.from("orders")
      .select("status, rider_name, rider_phone")
      .eq("id", placed.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          // Network/DB error on this verify call — skip, do not nuke the order.
          console.warn("[bp] Auto-verify fetch failed (skipping):", error?.message);
          return;
        }
        if (!data) {
          // Order not in DB — ghost order (insert never succeeded).
          console.warn("[bp] Ghost order — not found in DB:", placed.id);
          lsRemove(LS_ACTIVE_ORDER);
          sessionStorage.removeItem(SS_ORDER);
          setPlaced(null);
          setOrderError({
            payload: placed,
            paymentMethod: placed.payment_method,
            razorpayPaymentId: placed.razorpay_payment_id,
            wasMissing: true,
          });
          return;
        }
        // Order found — sync latest status into placed so OrderTracker prop stays fresh.
        const updated = { ...placed, status: data.status, rider_name: data.rider_name, rider_phone: data.rider_phone };
        if (!ACTIVE_STATUSES.has(data.status)) {
          lsRemove(LS_ACTIVE_ORDER);
          sessionStorage.removeItem(SS_ORDER);
          setPlaced(updated);
        } else {
          setPlaced(updated);
          sessionStorage.setItem(SS_ORDER, JSON.stringify(updated));
          lsSet(LS_ACTIVE_ORDER, JSON.stringify(updated));
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-refresh placed order status in parent so OrderTracker prop stays live.
  // Runs every 3s while an active order exists — no manual refresh needed.
  useEffect(() => {
    if (!placed || !SUPABASE_READY) return;
    if (!ACTIVE_STATUSES.has(placed.status)) return; // terminal — stop polling
    const t = setInterval(async () => {
      const { data } = await supabase
        .from("orders")
        .select("status, rider_name, rider_phone")
        .eq("id", placed.id)
        .maybeSingle();
      if (!data) return;
      if (data.status !== placed.status || data.rider_name !== placed.rider_name) {
        const updated = { ...placed, status: data.status, rider_name: data.rider_name, rider_phone: data.rider_phone };
        setPlaced(updated);
        if (ACTIVE_STATUSES.has(data.status)) {
          sessionStorage.setItem(SS_ORDER, JSON.stringify(updated));
          lsSet(LS_ACTIVE_ORDER, JSON.stringify(updated));
        } else {
          lsRemove(LS_ACTIVE_ORDER);
          sessionStorage.removeItem(SS_ORDER);
        }
      }
    }, 3000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed?.id, placed?.status]);

  // Fix 4: track whether menu is from DB or fallback cache
  const [menuIsStale, setMenuIsStale] = useState(false);
  // supabaseDown = env vars set but server unreachable (outage etc.)
  const [supabaseDown, setSupabaseDown] = useState(false);

  // Load dynamic menu from Supabase
  useEffect(() => {
    if (!SUPABASE_READY) { setMenuLoaded(true); setMenuIsStale(true); return; }
    supabase.from("menu_items").select("*")
      .then(({ data, error }) => {
        if (!error && data?.length) {
          const grouped = {};
          data.forEach(item => {
            if (!grouped[item.category]) grouped[item.category] = [];
            const parsed = { ...item, variants: item.variants || null, addons: item.addons || [] };
            grouped[item.category].push(parsed);
          });
          setMenu(grouped);
          setMenuIsStale(false);
          setSupabaseDown(false);
        } else if (error) {
          // Actual server/network error — trigger WhatsApp fallback
          setMenuIsStale(true);
          setSupabaseDown(true);
        } else {
          // data is [] — table is empty, but Supabase is reachable
          setMenuIsStale(true);
          setSupabaseDown(false);
        }
        setMenuLoaded(true);
      })
      .catch(() => {
        setMenuIsStale(true);
        setSupabaseDown(true);
        setMenuLoaded(true);
      });
  }, []);

  // Bug 4 Fix: retry every 30s when supabase is down — auto-recover without page reload
  useEffect(() => {
    if (!supabaseDown || !SUPABASE_READY) return;
    const t = setInterval(() => {
      supabase.from("menu_items").select("*")
        .then(({ data, error }) => {
          if (!error && data?.length) {
            const grouped = {};
            data.forEach(item => {
              if (!grouped[item.category]) grouped[item.category] = [];
              grouped[item.category].push({ ...item, variants: item.variants || null, addons: item.addons || [] });
            });
            setMenu(grouped);
            setMenuIsStale(false);
            setSupabaseDown(false);
          }
        });
    }, 30000);
    return () => clearInterval(t);
  }, [supabaseDown]);

  // Load categories fully from Supabase — id, label, emoji, sort_order, enabled
  // This means adding a new category in Supabase automatically shows it here;
  // no code deploy needed. CATEGORIES constant is only used as a last-resort fallback.
  useEffect(() => {
    if (!SUPABASE_READY) { setDbCategories([]); return; }
    supabase.from("categories").select("id, label, emoji, img, sort_order, enabled")
      .order("sort_order", { ascending: true })
      .then(({ data }) => setDbCategories(data || []));
  }, []);

  const visibleCategories = (() => {
    if (!dbCategories || dbCategories.length === 0) return CATEGORIES; // fallback if DB not ready yet
    return dbCategories
      .filter(c => c.enabled !== false)                     // hide disabled categories
      .filter(c => menu[c.id]?.length > 0 || !menuLoaded)  // hide categories with no items (once loaded)
      .map(c => ({
        id:    c.id,
        label: c.label,
        emoji: c.emoji || "🍽️",
        img:   c.img || CATEGORIES.find(hc => hc.id === c.id)?.img || null,
      }));
  })();

  useEffect(() => {
    if (!dbCategories) return;
    if (!visibleCategories.some(c => c.id === activeCat) && visibleCategories.length > 0) {
      setActiveCat(visibleCategories[0].id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbCategories, menuLoaded]);

  const enabledCatIds = new Set(visibleCategories.map(c => c.id));
  // ALL includes every item whose category is currently visible & enabled
  // Since menu is keyed by category id from Supabase, new categories auto-appear
  const ALL = Object.values(menu).flat().filter(i => enabledCatIds.has(i.category));

  const filteredItems = (() => {
    let items;
    if (search) items = ALL.filter(i => i.name.toLowerCase().includes(search.toLowerCase()));
    else items = ALL.filter(i => favs.includes(i.id));
    if (bizSettings.hide_unavailable_items) items = items.filter(i => i.is_available !== false);
    return items;
  })();

  // IntersectionObserver — highlight category pill as user scrolls (placed after visibleCategories)
  useEffect(() => {
    if (showFavs || search) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          const id = visible[0].target.id.replace("cat-section-", "");
          setActiveCat(id);
          if (catBarRef.current) {
            const pill = catBarRef.current.querySelector(`[data-cat="${id}"]`);
            if (pill) pill.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
          }
        }
      },
      { rootMargin: "-40% 0px -55% 0px", threshold: 0 }
    );
    visibleCategories.forEach(c => {
      const el = document.getElementById(`cat-section-${c.id}`);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [menuLoaded, showFavs, search, visibleCategories]);

  const cartCount = cart.reduce((s, i) => s + i.qty, 0);
  const cartTotal = cart.reduce((s, i) => s + i.finalPrice * i.qty, 0);

  const getCartQty = (name, variant = "") =>
    cart.filter(c => (c.name + (c.selectedVariant || "")) === (name + variant)).reduce((s, c) => s + c.qty, 0);

  const addItem = (item) => {
    setCart(prev => {
      const key = item.name + (item.selectedVariant || "") + (item.addonLabels?.join("") || "");
      const idx = prev.findIndex(c => (c.name + (c.selectedVariant || "") + (c.addonLabels?.join("") || "")) === key);
      if (idx >= 0) { const n = [...prev]; n[idx] = { ...n[idx], qty: n[idx].qty + (item.qty || 1) }; return n; }
      return [...prev, { ...item, qty: item.qty || 1, finalPrice: item.finalPrice ?? item.price }];
    });
    // Cart icon bounce
    setCartBouncing(true);
    setTimeout(() => setCartBouncing(false), 380);
    // Toast confirmation
    toast.success(`${item.name} added to cart`);
  };

  const setItemQty = (name, variant, qty) => {
    const key = name + variant;
    if (qty <= 0) setCart(prev => prev.filter(c => (c.name + (c.selectedVariant || "")) !== key));
    else setCart(prev => prev.map(c => (c.name + (c.selectedVariant || "")) === key ? { ...c, qty } : c));
  };

  const handleAdd = (item) => {
    if (item.variants?.length || item.addons?.length) { setItemModal(item); return; }
    addItem({ ...item, finalPrice: item.price, qty: 1 });
  };

  const handleQty  = (i, qty) => qty <= 0 ? setCart(p => p.filter((_, x) => x !== i)) : setCart(p => p.map((c, x) => x === i ? { ...c, qty } : c));
  const toggleFav  = (id) => { const next = favs.includes(id) ? favs.filter(f => f !== id) : [...favs, id]; setFavs(next); lsSet(LS_FAVS, JSON.stringify(next)); };

  const shareCart = async () => {
    if (!code || cart.length === 0) return;
    const encoded = btoa(JSON.stringify(cart.map(i => ({ id: i.id, qty: i.qty, v: i.selectedVariant }))));
    const url = `${window.location.origin}${window.location.pathname}#table=${code}&cart=${encoded}`;
    try { await navigator.share({ title: "Burger Point Cart", url }); } catch { await navigator.clipboard?.writeText(url); toast.success("Cart link copied!"); }
  };

  // Fix 8: share/copy order receipt
  const shareReceipt = async (order) => {
    const lines = (order.items || []).map(it => `• ${it.name}${it.selectedVariant ? ` (${it.selectedVariant})` : ""} ×${it.qty} — ₹${it.finalPrice * it.qty}`);
    const text = `🍔 Burger Point Order Receipt\n\n${lines.join("\n")}\n\nTotal: ₹${order.total}\nDate: ${new Date(order.created_at || Date.now()).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}\nPayment: ${order.payment_method || "Cash"}`;
    try {
      if (navigator.share) { await navigator.share({ title: "Burger Point Receipt", text }); }
      else { await navigator.clipboard.writeText(text); toast.success("Receipt copied to clipboard!"); }
    } catch { try { await navigator.clipboard.writeText(text); toast.success("Receipt copied!"); } catch {} }
  };

  const reorder = async (items) => {
    let toAdd = items;
    let skipped = [];
    // Check availability for items that have an id
    const ids = items.map(i => i.id).filter(Boolean);
    if (SUPABASE_READY && ids.length > 0) {
      const { data } = await supabase.from("menu_items").select("id, name, is_available").in("id", ids);
      if (data) {
        const unavailSet = new Set(data.filter(d => d.is_available === false).map(d => d.id));
        skipped = items.filter(i => unavailSet.has(i.id));
        toAdd = items.filter(i => !unavailSet.has(i.id));
      }
    }
    toAdd.forEach(item => addItem({ ...item, qty: item.qty || 1 }));
    if (skipped.length > 0) {
      toast.info(`Skipped: ${skipped.map(i => i.name).join(", ")} (no longer available)`);
    }
    // Scroll to menu
    setTimeout(() => menuAreaRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
  };

  const updateAvailable = useAppUpdateAvailable();
  const [showUpdateGate, setShowUpdateGate] = useState(false);
  // pending checkout opts — held while we collect customer info
  const [pendingOpts, setPendingOpts] = useState(null);

  const [cartValidationError, setCartValidationError] = useState(null); // Feature 9

  const [validating, setValidating] = useState(false); // true while pre-placement check runs

  const handlePlaceAttempt = async (opts) => {
    if (updateAvailable) { setShowCart(false); setShowUpdateGate(true); return; }

    // Feature 9: validate all cart items are still available.
    // Wrapped in a 3s timeout — if the DB is slow/unreachable, skip validation
    // and let the order through rather than blocking the customer indefinitely.
    if (SUPABASE_READY && cart.length > 0) {
      const ids = cart.map(i => i.id).filter(Boolean);
      if (ids.length > 0) {
        setValidating(true);
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 3000);
          const { data } = await supabase
            .from("menu_items")
            .select("id, name, is_available")
            .in("id", ids)
            .abortSignal(controller.signal);
          clearTimeout(timer);
          if (data) {
            const unavail = data.filter(d => d.is_available === false);
            if (unavail.length > 0) {
              const names = unavail.map(d => d.name).join(", ");
              setCartValidationError(`Sorry, these items are no longer available: ${names}. Please remove them to continue.`);
              setValidating(false);
              return;
            }
          }
          // If data is null (timeout/network error), fall through and place anyway
        } catch {
          // Timed out or network error — don't block the customer, place the order
        }
        setValidating(false);
      }
    }
    setCartValidationError(null);
    setShowCart(false);
    // For delivery/takeaway, collect info at checkout time if not already saved
    const needsInfo = (orderType === "delivery" || orderType === "takeaway")
      && (!customerInfo?.name || !customerInfo?.phone
          || (orderType === "delivery" && !customerInfo?.address));
    if (needsInfo) {
      setPendingOpts(opts); // Fix 10: always update opts, don't clobber with null
      setShowInfoModal(true);
      return;
    }
    // Bug 2 fix: dine-in has no online payment — skip RazorpayModal entirely
    // and place cash order directly. Only delivery/takeaway go through Razorpay modal.
    if (orderType === "dine-in") {
      finaliseOrder({ ...opts, _orderId: crypto.randomUUID() }, "Cash");
      return;
    }
    // If we already have pendingOpts from a previously-dismissed info sheet, keep them
    setPendingOpts(null);
    setShowRazorpay({ ...opts, _orderId: crypto.randomUUID() });
  };

  // Called when info modal is submitted
  const handleInfoSubmit = (info) => {
    saveCustomerInfo(info);
    setShowInfoModal(false);
    // Bug 5 fix: capture pendingOpts before clearing — if it somehow got cleared,
    // re-open cart so order is never silently dropped after info submission.
    const optsToUse = pendingOpts;
    setPendingOpts(null);
    if (optsToUse) {
      setShowRazorpay({ ...optsToUse, _orderId: crypto.randomUUID() });
    } else {
      setShowCart(true); // fallback: re-open cart so customer can retry
    }
  };

  const [orderError,    setOrderError]    = useState(null);  // Feature 2: placement error
  const [retrying,      setRetrying]      = useState(false);
  const [retryAttempt,  setRetryAttempt]  = useState(0);     // silent retry counter (1-3)

  // ── Resilient insert: up to 3 silent attempts with backoff ──────────────
  // Handles ~95% of transient poor-network failures without showing an error.
  // Skips retries for definitive DB errors (duplicate key, constraint violations).
  const insertWithRetry = async (payload, maxAttempts = 3) => {
    const delays = [0, 1500, 4000]; // immediate → 1.5s → 4s
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        setRetryAttempt(attempt); // show "Retrying (attempt X)…" in the spinner
        await new Promise(r => setTimeout(r, delays[attempt]));
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000); // 12s hard timeout
        const { error } = await supabase
          .from("orders")
          .insert(payload)
          .abortSignal(controller.signal);
        clearTimeout(timer);
        if (!error) { setRetryAttempt(0); return null; } // success
        lastErr = error;
        // Don't retry on definitive DB errors — retrying won't help
        if (["23505", "23503", "42501", "PGRST301"].includes(error.code)) break;
      } catch (err) {
        lastErr = err?.name === "AbortError"
          ? new Error("Request timed out — poor network. Check your connection.")
          : err;
      }
    }
    setRetryAttempt(0);
    return lastErr;
  };

  const finaliseOrder = async (opts, paymentMethod, razorpayPaymentId = null) => {
    const { note, total, discount, promoCode, deliveryFee, packingCharge, gstAmount, distanceKm } = opts;
    setShowRazorpay(null); setPlacing(true); setOrderError(null);
    const newItems = cart.map(i => ({ name: i.name, selectedVariant: i.selectedVariant || null, finalPrice: i.finalPrice, qty: i.qty, addonLabels: i.addonLabels || [] }));
    const payload = {
      id: opts._orderId || crypto.randomUUID(),
      table_code: code || null,
      table_label: tableLabel || null,
      order_type: orderType,
      customer_name: customerInfo?.name || null,
      customer_phone: customerInfo?.phone || null,
      delivery_address: customerInfo?.address || null,
      payment_method: paymentMethod || "Cash",
      razorpay_payment_id: razorpayPaymentId || null,
      items: newItems,
      total, note: note || "", status: "pending",
      discount: discount || 0, promo_code: promoCode || null,
      delivery_fee: deliveryFee || 0, packing_charge: packingCharge || 0, gst_amount: gstAmount || 0,
      delivery_distance_km: distanceKm ?? null,
      customer_lat: customerInfo?.lat ?? null, customer_lng: customerInfo?.lng ?? null,
      created_at: new Date().toISOString(),
      session_id: getSessionId(),
    };

    // ── Add-on request onto an existing open order, instead of a new one ──
    // If this table (dine-in) or this customer (takeaway) already has an
    // order that isn't finished yet, DON'T merge the items in silently.
    // Stage them in pending_addon_items on that same row and wait for staff
    // to approve — only then do they join the main items/bill. Delivery is
    // excluded: each delivery run is its own dispatch, never merged.
    let addonTarget = null;
    if (SUPABASE_READY && orderType !== "delivery") {
      try {
        let q = supabase.from("orders").select("id,status,items,total,created_at,order_type,pending_addon_items,pending_addon_total,addon_requested_at").order("created_at", { ascending: false }).limit(1);
        if (orderType === "dine-in" && code) {
          q = q.eq("table_code", code);
        } else if (orderType === "takeaway" && customerInfo?.phone) {
          q = q.eq("order_type", "takeaway").eq("customer_phone", customerInfo.phone);
        } else {
          q = null;
        }
        if (q) {
          const { data: candidates } = await q;
          const existing = (candidates || [])[0];
          // Only attach to orders still genuinely open, and (for takeaway)
          // only if it's recent — don't glue today's order onto a stale one.
          const recentEnough = !existing || orderType !== "takeaway"
            || (Date.now() - new Date(existing.created_at).getTime()) < 3 * 60 * 60 * 1000;
          // Don't stack a second add-on request on top of an unapproved one —
          // fold the new items into the same pending batch instead.
          if (existing && recentEnough && isOrderActive(existing)) {
            const combinedPendingItems = [...(existing.pending_addon_items || []), ...newItems];
            const combinedPendingTotal = Number(existing.pending_addon_total || 0) + Number(total || 0);
            const updatePayload = {
              pending_addon_items: combinedPendingItems,
              pending_addon_total: combinedPendingTotal,
              addon_requested_at: new Date().toISOString(),
            };
            const { data: updated, error } = await supabase.from("orders")
              .update(updatePayload).eq("id", existing.id).select().single();
            if (error) throw error;
            addonTarget = updated || { ...existing, ...updatePayload };
          }
        }
      } catch (err) {
        console.warn("[bp] add-on request failed, placing as a new order instead:", err?.message);
        addonTarget = null; // fall through to normal insert below
      }
    }

    if (addonTarget) {
      sessionStorage.setItem(SS_ORDER, JSON.stringify(addonTarget));
      lsSet(LS_ACTIVE_ORDER, JSON.stringify(addonTarget));
      saveHistory(addonTarget);
      setTimeout(() => {
        setCart([]); setPlacing(false);
        setPlaced(addonTarget);
      }, 800);
      return;
    }

    // Fix 2b: persist order to localStorage BEFORE the insert attempt
    // so a page-refresh during the placing spinner always finds the order
    sessionStorage.setItem(SS_ORDER, JSON.stringify(payload));
    lsSet(LS_ACTIVE_ORDER, JSON.stringify(payload));

    if (SUPABASE_READY) {
      try {
        const { error } = await supabase.from("orders").insert(payload);
        if (error) throw error;
      } catch (err) {
        console.warn("[bp] Order save error:", err);
        setPlacing(false);
        setOrderError({
          payload, paymentMethod, razorpayPaymentId,
          debugMessage: err?.message || String(err),
          debugCode: err?.code || null,
        });
        return;
      }
    }
    saveHistory(payload);
    setTimeout(() => {
      setCart([]); setPlacing(false);
      setPlaced(payload);
    }, 800);
  };

  const retryOrder = async () => {
    if (!orderError) return;
    setRetrying(true);
    const { payload } = orderError;

    // For "ghost" orders flagged by auto-verify, first check whether the
    // original insert actually DID succeed (it was a race-condition false
    // positive — the DB row just wasn't readable yet when we checked).
    // If the original exists, resume it rather than inserting a duplicate
    // that would send two orders to the kitchen.
    if (orderError.wasMissing && SUPABASE_READY) {
      try {
        const { data: existing } = await supabase
          .from("orders")
          .select("id, status, rider_name, rider_phone")
          .eq("id", payload.id)
          .maybeSingle();
        if (existing) {
          // Original IS in DB — it was a false positive. Just resume tracking.
          const resumed = {
            ...payload,
            status: existing.status,
            rider_name: existing.rider_name,
            rider_phone: existing.rider_phone,
          };
          sessionStorage.setItem(SS_ORDER, JSON.stringify(resumed));
          lsSet(LS_ACTIVE_ORDER, JSON.stringify(resumed));
          setOrderError(null);
          setRetrying(false);
          setPlaced(resumed);
          return;
        }
      } catch {
        // DB check failed — fall through to insert below
      }
    }

    // Original order confirmed absent — insert a new one.
    // Use a fresh ID so there is no duplicate-key conflict if the original
    // row somehow appears between now and the insert.
    const retryPayload = { ...payload, id: crypto.randomUUID(), session_id: getSessionId() };
    try {
      const { error } = await supabase.from("orders").insert(retryPayload);
      if (error) throw error;
    } catch (err) {
      console.warn("[bp] Retry error:", err);
      setOrderError(prev => ({
        ...prev,
        payload: retryPayload,
        debugMessage: err?.message || String(err),
        debugCode: err?.code || null,
      }));
      setRetrying(false);
      return;
    }
    saveHistory(retryPayload);
    sessionStorage.setItem(SS_ORDER, JSON.stringify(retryPayload));
    lsSet(LS_ACTIVE_ORDER, JSON.stringify(retryPayload));
    setCart([]);
    setOrderError(null);
    setRetrying(false);
    setPlacing(false);
    setPlaced(retryPayload);
  };

  // Fix 1 + Feature 2: full-screen error card — special message when payment already captured
  // Background auto-retry: every 15s for non-paid errors — customer may do nothing and it recovers.
  useEffect(() => {
    if (!orderError || orderError.razorpayPaymentId || retrying) return;
    const t = setInterval(() => {
      if (!retrying) retryOrder();
    }, 15000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderError, retrying]);

  // Countdown to next auto-retry — shown in the error UI
  const [autoRetryCountdown, setAutoRetryCountdown] = useState(15);
  useEffect(() => {
    if (!orderError || orderError.razorpayPaymentId) return;
    setAutoRetryCountdown(15);
    const tick = setInterval(() => setAutoRetryCountdown(c => (c <= 1 ? 15 : c - 1)), 1000);
    return () => clearInterval(tick);
  }, [orderError]);

  if (orderError) {
    const paidOnline = !!orderError.razorpayPaymentId;
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-red-50 gap-5 p-6 text-center">
        <div className="w-20 h-20 rounded-full bg-red-100 flex items-center justify-center text-4xl">
          {paidOnline ? "💳" : "❌"}
        </div>
        <div>
          <p className="font-black text-stone-800 text-xl mb-2">
            {paidOnline ? "Payment captured — but order didn't save"
              : orderError.wasMissing ? "That order never actually went through"
              : "Order couldn't be placed"}
          </p>
          {paidOnline ? (
            <div className="bg-white border border-red-200 rounded-2xl px-4 py-3 max-w-xs mx-auto mb-2">
              <p className="text-xs font-bold text-red-600 mb-1">⚠️ Your money is safe</p>
              <p className="text-xs text-stone-600">Payment ID: <span className="font-mono font-bold text-stone-800">{orderError.razorpayPaymentId}</span></p>
              <p className="text-xs text-stone-500 mt-1">Screenshot this and call us — we'll confirm your order manually.</p>
            </div>
          ) : orderError.wasMissing ? (
            <p className="text-sm text-stone-500">It looked placed on your screen, but the kitchen never got it — likely a dropped connection right when you ordered. Nothing was charged. Please try again.</p>
          ) : (
            <>
              <p className="text-sm text-stone-500">Check your connection and try again — your cart is still saved.</p>
              {orderError.debugMessage && (
                <div className="bg-white border border-red-200 rounded-xl px-3 py-2 mt-3 max-w-xs mx-auto text-left">
                  <p className="text-[10px] font-bold text-red-500 uppercase tracking-wide">Error details (send this to support)</p>
                  {orderError.debugCode && <p className="text-[11px] font-mono text-stone-600 mt-1">Code: {orderError.debugCode}</p>}
                  <p className="text-[11px] font-mono text-stone-600 mt-0.5 break-words">{orderError.debugMessage}</p>
                </div>
              )}
            </>
          )}
        </div>
        <button onClick={retryOrder} disabled={retrying}
          className="flex items-center gap-2 bg-gradient-to-r from-orange-500 to-red-500 text-white px-8 py-4 rounded-2xl font-bold text-sm shadow-lg active:scale-95 transition-transform disabled:opacity-60">
          {retrying ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Retrying…</> : "🔄 Try Again"}
        </button>
        {/* Auto-retry countdown — only for non-paid, non-ghost errors */}
        {!paidOnline && !orderError.wasMissing && !retrying && (
          <p className="text-xs text-stone-400 -mt-3">
            Auto-retrying in {autoRetryCountdown}s…
          </p>
        )}
        <a href="tel:+919194008822" className="flex items-center gap-2 border border-orange-200 text-orange-600 font-bold text-sm px-6 py-3 rounded-2xl">
          <Phone size={14} /> Call Restaurant
        </a>
        {/* wasMissing = cart already cleared before ghost was detected, nothing to go back to.
             Regular errors keep the cart intact so going back is useful. */}
        {!paidOnline && !orderError.wasMissing && (
          <button onClick={() => setOrderError(null)} className="text-xs text-stone-400 underline">Go back to cart</button>
        )}
        {orderError.wasMissing && (
          <button onClick={() => { setOrderError(null); lsRemove(LS_CART); window.location.reload(); }} className="text-xs text-stone-400 underline">Start a new order</button>
        )}
      </div>
    );
  }

  if (placing) return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-orange-50 gap-4">
      <div className="w-20 h-20 rounded-full bg-orange-100 flex items-center justify-center text-4xl">🍔</div>
      <p className="font-bold text-stone-700 text-lg">
        {retryAttempt > 0 ? `Retrying… (attempt ${retryAttempt + 1} of 3)` : "Sending to kitchen…"}
      </p>
      {retryAttempt > 0 && (
        <p className="text-xs text-stone-400 -mt-2">Poor connection detected — hanging on…</p>
      )}
      <div className="flex gap-1.5">{[0, 1, 2].map(i => <div key={i} className="w-2 h-2 rounded-full bg-orange-400 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />)}</div>
    </div>
  );

  if (placed) return <OrderTracker order={placed} tableLabel={tableLabel} onNewOrder={() => { sessionStorage.removeItem(SS_ORDER); setPlaced(null); }} />;

  if (bizSettings.emergency_close || bizSettings.holiday_mode) return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-orange-50 gap-3 p-6 text-center">
      <div className="w-20 h-20 rounded-full bg-orange-100 flex items-center justify-center text-4xl">😴</div>
      <p className="font-black text-stone-800 text-lg">We're currently closed</p>
      <p className="text-sm text-stone-500 max-w-xs">
        {bizSettings.emergency_close
          ? "We've had to pause orders temporarily. Please check back shortly!"
          : "We're closed today for a holiday. We'll be back soon — thanks for your patience!"}
      </p>
      {bizSettings.phone && <a href={`tel:${bizSettings.phone}`} className="mt-2 text-xs font-bold text-orange-600 underline">Call us: {bizSettings.phone}</a>}
    </div>
  );

  const typeLabel = orderType === "delivery" ? "🛵 Delivery" : orderType === "takeaway" ? "📦 Takeaway" : null;
  const activeCatData = visibleCategories.find(c => c.id === activeCat);

  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-white border-b border-stone-100">
        <div className="max-w-2xl mx-auto px-3 pt-2 pb-1.5">

          {/* Location bar — delivery only */}
          {orderType === "delivery" && (
            <button
              onClick={() => setShowInfoModal(true)}
              className="w-full flex items-center gap-1.5 bg-orange-50 border border-orange-200 rounded-xl px-2.5 py-1.5 mb-1.5 active:scale-[0.98] transition-transform text-left">
              <MapPin size={12} className="text-orange-500 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[9px] font-bold text-orange-500 uppercase tracking-wider leading-none">
                  {orderType === "delivery" ? "Delivering to" : "Takeaway"}
                </p>
                <p className="text-[11px] font-bold text-stone-800 truncate leading-tight">
                  {orderType === "delivery"
                    ? (customerInfo?.address || "Add delivery address")
                    : "Burger Point, Jankipuram"}
                </p>
              </div>
              <span className="text-[9px] font-bold text-orange-500 flex-shrink-0">
                {customerInfo?.name ? "Change ›" : "Add ›"}
              </span>
            </button>
          )}

          {/* Top row — logo + actions + search */}
          <div className="flex items-center gap-2">
            <span className="text-lg flex-shrink-0">🍔</span>
            <div className="flex-1 flex items-center gap-2 bg-stone-100 rounded-xl px-2.5 py-1.5">
              <Search size={12} className="text-stone-400 flex-shrink-0" />
              <input value={search} onChange={e => { setSearch(e.target.value); setShowFavs(false); }} placeholder="Search menu…"
                className="flex-1 text-xs bg-transparent outline-none text-stone-700 placeholder-stone-400" />
              {search && <button onClick={() => setSearch("")}><X size={11} className="text-stone-400" /></button>}
            </div>
            <button onClick={() => setShowHistory(true)} className="w-7 h-7 rounded-lg bg-stone-100 flex items-center justify-center flex-shrink-0">
              <History size={13} className="text-stone-500" />
            </button>
            <span className="bg-gradient-to-r from-orange-500 to-red-500 text-white text-[10px] font-bold px-2 py-1 rounded-lg shadow-sm flex-shrink-0">
              {tableLabel || typeLabel || "Menu"}
            </span>
            <button onClick={() => { clearTableSession(); window.location.hash = ""; }} className="text-[10px] text-stone-400 flex-shrink-0">✕</button>
          </div>
        </div>

        {/* ✨ Today's Special */}
        {!menuLoaded ? null : todaySpecial && !search && !showFavs && (
          <div className="px-3 pt-2 pb-1">
            <div className="bg-gradient-to-r from-orange-500 to-red-500 rounded-2xl p-3 flex items-center gap-3 shadow-sm">
              <div className="w-16 h-16 rounded-xl overflow-hidden flex-shrink-0 bg-orange-400">
                <ItemThumb item={todaySpecial} className="w-full h-full rounded-none object-cover" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[9px] font-black text-orange-100 uppercase tracking-widest mb-0.5">⚡ {bizSettings.special_label || "Today's Special"}</p>
                <p className="text-sm font-black text-white leading-tight truncate">{todaySpecial.name}</p>
                {todaySpecial.description && <p className="text-[10px] text-orange-100 mt-0.5 line-clamp-1">{todaySpecial.description}</p>}
                <p className="text-base font-black text-white mt-1">₹{todaySpecial.price}</p>
              </div>
              <button onClick={() => { setItemModal(todaySpecial); }}
                className="flex-shrink-0 bg-white text-orange-600 font-black text-xs px-3 py-2 rounded-xl active:scale-95 transition-all shadow-sm">
                ADD
              </button>
            </div>
          </div>
        )}

        {/* 🔥 Bestsellers — collapses to strip on scroll down */}
        {!menuLoaded ? null : bestsellers.size > 0 && !search && !showFavs ? (
          <div className="px-3 pt-2 pb-1 transition-all duration-300">
            <div className="flex items-center justify-between mb-2 cursor-pointer" onClick={() => setBsCollapsed(c => !c)}>
              <div className="flex items-center gap-1.5">
                <span className="text-sm">🔥</span>
                <p className="text-sm font-black text-stone-800">Bestsellers</p>
              </div>
              <span className="text-[10px] text-stone-400 font-semibold">{bsCollapsed ? "▼ Show" : "▲ Hide"}</span>
            </div>
            {bsCollapsed ? (
              /* Collapsed: compact horizontal strip */
              <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
                {Object.values(menu).flat().filter(i => bestsellers.has(i.id) && i.is_available !== false).slice(0, 8).map(item => (
                  <button key={item.id} onClick={() => setItemModal(item)}
                    className="flex-shrink-0 flex items-center gap-1.5 bg-orange-50 border border-orange-100 rounded-xl px-2 py-1.5 active:scale-95 transition-transform">
                    <div className="w-7 h-7 rounded-lg overflow-hidden flex-shrink-0 bg-stone-200">
                      <ItemThumb item={item} className="w-full h-full rounded-none" />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-stone-800 whitespace-nowrap max-w-[70px] truncate">{item.name}</p>
                      <p className="text-[9px] font-black text-orange-600">₹{item.price}</p>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              /* Expanded: 2-column grid */
              <div className="grid grid-cols-2 gap-2">
                {Object.values(menu).flat().filter(i => bestsellers.has(i.id) && i.is_available !== false).slice(0, 6).map(item => (
                  <button key={item.id} onClick={() => setItemModal(item)}
                    className="bg-white border border-stone-100 rounded-2xl p-2 flex items-center gap-2 shadow-sm active:scale-[0.97] transition-all text-left">
                    <div className="w-12 h-12 rounded-xl overflow-hidden flex-shrink-0 bg-stone-100">
                      <ItemThumb item={item} className="w-full h-full rounded-none object-cover" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-bold text-stone-800 leading-tight line-clamp-2">{item.name}</p>
                      <p className="text-[11px] font-black text-orange-600 mt-0.5">₹{item.price}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {/* Category bar */}
        {!search && (
          !menuLoaded ? <CategoryBarSkeleton /> : (
            <div ref={catBarRef} className="flex gap-1.5 px-3 py-1.5 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
              <button onClick={() => { setShowFavs(f => !f); setActiveCat("burgers"); }}
                className={`flex-shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all ${showFavs ? "bg-red-500 text-white" : "bg-stone-100 text-stone-500"}`}>
                <Heart size={9} className={showFavs ? "fill-white" : ""} /> Favs {favs.length > 0 && `(${favs.length})`}
              </button>
              {visibleCategories.map(c => (
                <button key={c.id}
                  data-cat={c.id}
                  onClick={() => {
                    setShowFavs(false);
                    setActiveCat(c.id);
                    const el = document.getElementById(`cat-section-${c.id}`);
                    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                  className={`flex-shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all ${!showFavs && activeCat === c.id ? "bg-gradient-to-r from-orange-500 to-red-500 text-white shadow-sm" : "bg-stone-100 text-stone-500"}`}>
                  {c.emoji} {c.label}
                </button>
              ))}
            </div>
          )
        )}
      </div>

      {/* Fix 3: no-live-ordering warning when Supabase env vars missing */}
      {!SUPABASE_READY && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2.5 flex items-center gap-2 max-w-2xl mx-auto w-full">
          <span className="text-amber-600 text-xs">⚠️</span>
          <p className="text-xs text-amber-800 font-medium flex-1">Live ordering unavailable — please call us to order: <a href="tel:+919194008822" className="font-bold underline">+91 91940 08822</a></p>
        </div>
      )}
      {/* Server down banner — env vars set but Supabase unreachable */}
      {SUPABASE_READY && supabaseDown && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2.5 flex items-center gap-2 max-w-2xl mx-auto w-full">
          <span className="text-lg">⚠️</span>
          <p className="text-xs text-amber-800 font-medium flex-1">
            Server temporarily down — <strong>add items to cart</strong> and order directly via WhatsApp!
          </p>
        </div>
      )}
      {/* Fix 4: stale menu warning when showing cached/hardcoded items */}
      {menuIsStale && SUPABASE_READY && menuLoaded && (
        <div className="bg-stone-100 border-b border-stone-200 px-4 py-2 max-w-2xl mx-auto w-full">
          <p className="text-xs text-stone-500 text-center">Showing cached menu — prices may differ. <a href="tel:+919194008822" className="text-orange-500 font-bold">Call to confirm.</a></p>
        </div>
      )}

      {/* Menu — continuous scroll with all categories */}
      <div className="flex-1 max-w-2xl mx-auto w-full px-4 pb-32" ref={menuAreaRef}>
        {!menuLoaded ? (
          <MenuSkeleton count={5} />
        ) : (search || showFavs) ? (
          <>
            <p className="text-xs text-stone-400 font-medium py-3">
              {showFavs ? `${filteredItems.length} saved item${filteredItems.length !== 1 ? "s" : ""}` : `${filteredItems.length} result${filteredItems.length !== 1 ? "s" : ""} for "${search}"`}
            </p>
            {filteredItems.length === 0 ? (
              <div className="flex flex-col items-center text-center py-16 px-4">
                <span className="text-4xl mb-3">{showFavs ? "❤️" : "🔍"}</span>
                <p className="text-sm font-bold text-stone-700">{showFavs ? "No favourites yet" : `No items match "${search}"`}</p>
                <p className="text-xs text-stone-400 mt-1 max-w-[220px]">{showFavs ? "Tap the ♡ on any item to save it here." : "Try a different spelling or browse categories."}</p>
                <button onClick={() => { setSearch(""); setShowFavs(false); }} className="mt-4 text-xs font-bold text-orange-600 bg-orange-50 px-4 py-2 rounded-full">Browse Menu</button>
              </div>
            ) : filteredItems.map(item => (
              <ItemCard key={item.id} item={item}
                cartQty={getCartQty(item.name, item.selectedVariant || "")}
                onAdd={handleAdd}
                onQtyChange={qty => setItemQty(item.name, "", qty)}
                isFav={favs.includes(item.id)}
                onToggleFav={toggleFav}
                isBestseller={bestsellers.has(item.id)} />
            ))}
          </>
        ) : (
          // Continuous scroll — all categories rendered at once
          visibleCategories.map(cat => {
            const catItems = (menu[cat.id] || []).filter(i => enabledCatIds.has(i.category));
            if (catItems.length === 0) return null;
            return (
              <div key={cat.id} id={`cat-section-${cat.id}`} className="scroll-mt-32">
                {/* Category header with image */}
                <div className="my-3 relative rounded-2xl overflow-hidden h-24">
                  <img src={cat.img} alt={cat.label}
                    onError={e => { e.target.parentElement.style.background = "linear-gradient(to right,#fed7aa,#fef3c7)"; e.target.style.display = "none"; }}
                    className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-gradient-to-r from-black/60 to-transparent flex items-end p-4">
                    <div>
                      <p className="text-white font-black text-base leading-tight">{cat.emoji} {cat.label}</p>
                      <p className="text-white/70 text-xs">{catItems.length} items</p>
                    </div>
                  </div>
                </div>
                {catItems.map(item => (
                  <ItemCard key={item.id} item={item}
                    cartQty={getCartQty(item.name, item.selectedVariant || "")}
                    onAdd={handleAdd}
                    onQtyChange={qty => setItemQty(item.name, "", qty)}
                    isFav={favs.includes(item.id)}
                    onToggleFav={toggleFav}
                    isBestseller={bestsellers.has(item.id)} />
                ))}
              </div>
            );
          })
        )}
      </div>

      {/* Cart bar — with bounce micro-interaction */}
      {cartCount > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-20 px-4 pb-4">
          <button onClick={() => setShowCart(true)}
            className={`w-full max-w-2xl mx-auto flex bg-gradient-to-r from-orange-500 to-red-600 text-white px-5 py-4 rounded-2xl items-center justify-between font-bold text-sm shadow-xl active:scale-95 transition-transform ${cartBouncing ? "cart-bounce" : ""}`}>
            <div className="flex items-center gap-2.5">
              <span className={`bg-white/25 text-white text-xs font-black px-2 py-0.5 rounded-lg ${cartBouncing ? "cart-bounce" : ""}`}>{cartCount}</span>
              <span>{cartCount} item{cartCount > 1 ? "s" : ""} in cart</span>
            </div>
            <span className="font-black">₹{cartTotal} →</span>
          </button>
        </div>
      )}

      {itemModal && <ItemModal item={itemModal} onClose={() => setItemModal(null)} onAdd={entry => { addItem(entry); setItemModal(null); }} />}
      {showCart && (
        <CartDrawer cart={cart} tableLabel={tableLabel} orderType={orderType} customerInfo={customerInfo} settings={bizSettings}
          onClose={() => setShowCart(false)} onQty={handleQty} onRemove={i => { setCart(p => p.filter((_, x) => x !== i)); setCartValidationError(null); }} onPlace={handlePlaceAttempt}
          unavailableIds={unavailableCartIds} validationError={cartValidationError} supabaseDown={supabaseDown}
          menu={menu} bestsellers={bestsellers} onAddSuggested={(item) => { handleAdd(item); }} validating={validating}
          promoBannerUrl={bizSettings.promo_banner_enabled ? bizSettings.promo_banner_url : null} />
      )}
      {showRazorpay && (
        <RazorpayModal amount={showRazorpay.total} customerName={customerInfo?.name || tableLabel || "Customer"} customerPhone={customerInfo?.phone}
          orderId={showRazorpay._orderId}
          onSuccess={(paymentId) => finaliseOrder(showRazorpay, "Razorpay (Online)", paymentId)}
          onCash={() => finaliseOrder(showRazorpay, "Cash")}
          onClose={() => setShowRazorpay(null)}
          onCancel={() => setShowRazorpay(null)} />
      )}
      {showInfoModal && (
        <CheckoutInfoSheet
          orderType={orderType}
          existing={customerInfo}
          onSubmit={handleInfoSubmit}
          onClose={() => {
            setShowInfoModal(false);
            // Fix 10: keep pendingOpts alive so customer can re-open cart without re-configuring
            // Don't call setPendingOpts(null) here — only clear on a successful submit or explicit cancel
          }}
        />
      )}
      {showHistory && <OrderHistoryModal onClose={() => setShowHistory(false)} onReorder={reorder} onShareReceipt={shareReceipt} />}
      {pushBanner && <PushBanner onAllow={pushAllow} onDismiss={pushDismiss} />}
      {showBannerPopup && <PromoBannerPopup url={bizSettings.promo_banner_url} onDismiss={dismissBanner} />}
      {showUpdateGate && (
        <div className="fixed inset-0 bg-black/60 z-[70] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-6 max-w-xs w-full text-center shadow-2xl">
            <div className="w-16 h-16 rounded-full bg-orange-100 flex items-center justify-center text-3xl mx-auto mb-3">🔄</div>
            <p className="font-black text-stone-800 text-lg">Update Available</p>
            <p className="text-sm text-stone-500 mt-2">A newer version of Burger Point is ready. Please update to continue placing your order — this only takes a second and your cart will be kept.</p>
            <button onClick={() => { window.__bpApplyUpdate?.(); }}
              className="w-full mt-5 bg-gradient-to-r from-orange-500 to-red-600 text-white py-3 rounded-2xl font-bold text-sm active:scale-95 transition-transform">
              Update Now
            </button>
            <button onClick={() => setShowUpdateGate(false)} className="w-full mt-2 text-xs text-stone-400 py-2">Not now</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── LANDING PAGE ── moved to LandingPage.jsx (imported directly by App.jsx) ──

// ── CUSTOMER INFO FORM ────────────────────────────────────
export function CustomerInfoForm({ orderType, onSubmit }) {
  const [name,     setName]     = useState("");
  const [phone,    setPhone]    = useState("");
  const [house,    setHouse]    = useState("");   // House/Flat/Shop No.
  const [floor,    setFloor]    = useState("");   // Floor (optional)
  const [street,   setStreet]   = useState("");   // Street / Colony / Mohalla
  const [landmark, setLandmark] = useState("");   // Nearby landmark
  const [err,      setErr]      = useState("");
  const [coords,   setCoords]   = useState(null);  // { lat, lng }
  const [locating, setLocating] = useState(false);
  const [locErr,   setLocErr]   = useState("");
  const [pinMode,  setPinMode]  = useState(false); // manual pin drop mode
  const { settings } = useBusinessSettings();
  const { addresses: savedAddrs, save: saveAddr, remove: removeAddr } = useSavedAddresses();
  const toast = useToast();

  const [roadDistKm,   setRoadDistKm]   = useState(null);
  const [checkingDist, setCheckingDist] = useState(false);
  const [isApproxDist, setIsApproxDist] = useState(false);

  // Fetch real road distance when coords change
  useEffect(() => {
    if (!coords) { setRoadDistKm(null); setIsApproxDist(false); return; }
    const rLat = settings.restaurant_lat || 26.926287;
    const rLng = settings.restaurant_lng || 80.942995;
    setCheckingDist(true);
    setIsApproxDist(false);
    fetch(`https://router.project-osrm.org/route/v1/driving/${rLng},${rLat};${coords.lng},${coords.lat}?overview=false`)
      .then(r => r.json())
      .then(d => {
        const km = d.routes?.[0]?.distance / 1000;
        setRoadDistKm(km ?? null);
        setIsApproxDist(false);
      })
      .catch(() => {
        // OSRM failed — fallback to haversine with 1.3x buffer to cover road vs straight-line gap
        const straight = haversineKm(rLat, rLng, coords.lat, coords.lng);
        setRoadDistKm(straight != null ? straight * 1.3 : null);
        setIsApproxDist(true);
      })
      .finally(() => setCheckingDist(false));
  }, [coords?.lat, coords?.lng, settings.restaurant_lat, settings.restaurant_lng]);

  const distanceKm = roadDistKm;
  const deliveryPreview = orderType === "delivery"
    ? calculateDelivery(distanceKm, 0, settings)
    : null;

  const useMyLocation = () => {
    if (!navigator.geolocation) { setLocErr("Location isn't supported on this browser."); return; }
    setLocating(true); setLocErr("");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        setCoords({ lat, lng });
        toast.success("Location captured ✓");
        setLocating(false);
      },
      () => { setLocErr("Couldn't get your location — please allow location access."); setLocating(false); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  // Fill form from a saved address
  const applySavedAddress = (a) => {
    setHouse(a.house || "");
    setFloor(a.floor || "");
    setStreet(a.street || "");
    setLandmark(a.landmark || "");
    if (a.lat && a.lng) setCoords({ lat: a.lat, lng: a.lng });
    toast.info("Address loaded");
  };

  const buildAddress = () => {
    const parts = [
      house.trim(),
      floor.trim() ? `Floor ${floor.trim()}` : "",
      street.trim(),
      landmark.trim() ? `Near ${landmark.trim()}` : "",
      "Lucknow",
    ].filter(Boolean);
    return parts.join(", ");
  };

  const submit = () => {
    if (!name.trim())            { setErr("Please enter your name."); return; }
    if (!/^\d{10}$/.test(phone)) { setErr("Enter a valid 10-digit phone number."); return; }
    if (orderType === "delivery") {
      if (!house.trim())   { setErr("Please enter house/flat/shop number."); return; }
      if (!street.trim())  { setErr("Please enter street / colony name."); return; }
      if (deliveryPreview?.deliverable === false) { setErr(deliveryPreview.reason); return; }
      // Save address for next time
      const full = buildAddress();
      if (full.length > 5) {
        saveAddr({
          label: house.trim().slice(0, 30),
          house: house.trim(), floor: floor.trim(),
          street: street.trim(), landmark: landmark.trim(),
          lat: coords?.lat ?? null, lng: coords?.lng ?? null,
          fullAddress: full,
        });
      }
    }
    onSubmit({ name: name.trim(), phone, address: buildAddress(), lat: coords?.lat ?? null, lng: coords?.lng ?? null });
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-orange-50 to-amber-50 p-4">
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-xl border border-orange-100 p-6">
        <button onClick={() => window.location.hash = ""} className="text-xs text-stone-400 flex items-center gap-1 mb-4"><ArrowLeft size={12} /> Back</button>
        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-gradient-to-br from-orange-100 to-amber-100 rounded-3xl flex items-center justify-center text-4xl mx-auto mb-3">
            {orderType === "delivery" ? "🛵" : "📦"}
          </div>
          <h2 className="font-black text-stone-800 text-xl">{orderType === "delivery" ? "Delivery Order" : "Takeaway Order"}</h2>
          <p className="text-xs text-stone-400 mt-1">Fill in your details to continue</p>
        </div>
        <div className="space-y-3">
          {/* Name */}
          <div>
            <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Your Name *</label>
            <div className="relative">
              <User size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
              <input value={name} onChange={e => { setName(e.target.value); setErr(""); }} placeholder="e.g. Rahul Sharma"
                className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-2xl pl-9 pr-4 py-3 outline-none text-stone-700 transition-colors" />
            </div>
          </div>
          {/* Phone */}
          <div>
            <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Phone Number *</label>
            <div className="relative">
              <Phone size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
              <input value={phone} onChange={e => { setPhone(e.target.value.replace(/\D/g, "").slice(0, 10)); setErr(""); }} placeholder="10-digit mobile number" inputMode="numeric"
                className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-2xl pl-9 pr-4 py-3 outline-none text-stone-700 transition-colors" />
            </div>
          </div>

          {/* Address fields — delivery only */}
          {orderType === "delivery" && (
            <div className="space-y-2">
              <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest flex items-center gap-1 mt-1">
                <MapPin size={9} /> Delivery Address
              </p>

              {/* Saved addresses */}
              <SavedAddressPicker
                addresses={savedAddrs}
                onSelect={applySavedAddress}
                onRemove={removeAddr}
              />

              {/* Location capture for distance-based delivery fee */}
              <div className="flex gap-2">
                <button type="button" onClick={useMyLocation} disabled={locating}
                  className="flex-1 flex items-center justify-center gap-2 text-xs font-bold text-orange-600 bg-orange-50 border border-orange-200 rounded-xl py-2.5 disabled:opacity-60">
                  <Navigation size={13} /> {locating ? "Locating…" : coords ? "📍 Location saved — refresh" : "📍 Use my location"}
                </button>
                <button type="button"
                  onClick={() => {
                    toast.info("Open Google Maps, long-press your building, then share the coordinates with us in the order note.");
                  }}
                  className="flex items-center justify-center gap-1 text-xs font-bold text-blue-600 bg-blue-50 border border-blue-200 rounded-xl px-3 py-2.5">
                  📌 Pin
                </button>
              </div>
              {locErr && <p className="text-[11px] text-amber-600">{locErr}</p>}
              {deliveryPreview && coords && (
                deliveryPreview.deliverable ? (
                  <>
                    <div className="bg-green-50 border border-green-200 rounded-xl px-3 py-2 text-xs text-green-700 flex items-center justify-between">
                      <span>{checkingDist ? "Checking road distance…" : `~${deliveryPreview.distanceKm.toFixed(1)} km${isApproxDist ? " (approx)" : " (road)"} · ~${deliveryPreview.etaMinutes} min`}</span>
                      <span className="font-bold">{deliveryPreview.freeDelivery ? "FREE delivery" : `+₹${deliveryPreview.fee} delivery`}</span>
                    </div>
                    {isApproxDist && !checkingDist && (
                      <div className="flex items-start gap-1.5 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-700">
                        <span className="flex-shrink-0">⚠️</span>
                        <span>Distance is approximate — road routing unavailable right now. Actual delivery fee may vary slightly.</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-xs text-red-600">
                    {deliveryPreview.reason}
                  </div>
                )
              )}

              <div className="bg-orange-50 border border-orange-100 rounded-2xl p-3 space-y-2">

                {/* House / Flat / Shop No */}
                <div>
                  <label className="text-[10px] font-semibold text-stone-500 block mb-1">🏠 House / Flat / Shop No. *</label>
                  <input value={house} onChange={e => { setHouse(e.target.value); setErr(""); }}
                    placeholder="e.g. H-42, Flat 3B, Shop 7"
                    className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2.5 outline-none text-stone-700 bg-white" />
                </div>

                {/* Floor (optional) */}
                <div>
                  <label className="text-[10px] font-semibold text-stone-500 block mb-1">🏢 Floor <span className="font-normal text-stone-400">(optional)</span></label>
                  <input value={floor} onChange={e => { setFloor(e.target.value); setErr(""); }}
                    placeholder="e.g. Ground, 1st, 2nd"
                    className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2.5 outline-none text-stone-700 bg-white" />
                </div>

                {/* Street / Colony */}
                <div>
                  <label className="text-[10px] font-semibold text-stone-500 block mb-1">🛣️ Street / Colony / Mohalla *</label>
                  <input value={street} onChange={e => { setStreet(e.target.value); setErr(""); }}
                    placeholder="e.g. Sector C, Jankipuram"
                    className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2.5 outline-none text-stone-700 bg-white" />
                </div>

                {/* Landmark */}
                <div>
                  <label className="text-[10px] font-semibold text-stone-500 block mb-1">📍 Nearby Landmark <span className="font-normal text-stone-400">(optional)</span></label>
                  <input value={landmark} onChange={e => { setLandmark(e.target.value); setErr(""); }}
                    placeholder="e.g. Near City Hospital, Opp. Park"
                    className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2.5 outline-none text-stone-700 bg-white" />
                </div>
              </div>

              {/* Address preview */}
              {(house || street) && (
                <div className="bg-green-50 border border-green-100 rounded-xl px-3 py-2">
                  <p className="text-[10px] font-bold text-green-600 mb-0.5">📋 Address Preview</p>
                  <p className="text-xs text-stone-600">{buildAddress()}</p>
                </div>
              )}

              <p className="text-[10px] text-orange-500 flex items-center gap-1"><Navigation size={9} /> We deliver within 5 km of Jankipuram</p>
            </div>
          )}
        </div>
        {err && <p className="text-red-500 text-xs mt-3 font-medium text-center">{err}</p>}
        <button onClick={submit} className="w-full mt-5 bg-gradient-to-r from-orange-500 to-red-500 text-white py-4 rounded-2xl font-bold text-sm shadow-md active:scale-95 transition-transform">
          {orderType === "delivery" ? "🛵 Continue to Menu" : "📦 Continue to Menu"}
        </button>
      </div>
    </div>
  );
}

// ── RESERVATION PAGE ──────────────────────────────────────
// SQL migration needed: ALTER TABLE reservations ADD COLUMN IF NOT EXISTS pre_order_items jsonb DEFAULT '[]';
export function ReservationPage() {
  // ── Existing reservation check ──
  const [resv, setResv] = useState(() => {
    try { const r = JSON.parse(localStorage.getItem(LS_RESERVATION) || "null"); return r; } catch { return null; }
  });

  // ── Form state ──
  const [step,   setStep]   = useState(1); // 1=basic info, 2=pre-order food
  const [name,   setName]   = useState(() => { try { return JSON.parse(localStorage.getItem(LS_CUSTOMER) || "{}").name || ""; } catch { return ""; } });
  const [phone,  setPhone]  = useState(() => { try { return JSON.parse(localStorage.getItem(LS_CUSTOMER) || "{}").phone || ""; } catch { return ""; } });
  const [date,   setDate]   = useState("");
  const [time,   setTime]   = useState("");
  const [guests, setGuests] = useState(2);
  const [note,   setNote]   = useState("");
  const [err,    setErr]    = useState("");
  const [saving, setSaving] = useState(false);

  // ── Pre-order (step 2) ──
  const [preCart, setPreCart] = useState([]); // [{id, name, price, qty}]
  const [menuItems, setMenuItems] = useState([]);
  const [menuCat,   setMenuCat]   = useState("burgers");
  const [menuLoaded, setMenuLoaded] = useState(false);

  // Load menu for pre-order step
  useEffect(() => {
    if (menuLoaded) return;
    if (SUPABASE_READY) {
      supabase.from("menu_items").select("id,name,price,category,is_available").eq("is_available", true).order("category")
        .then(({ data }) => {
          setMenuItems(data?.length ? data : ALL_ITEMS);
          setMenuLoaded(true);
        }).catch(() => { setMenuItems(ALL_ITEMS); setMenuLoaded(true); });
    } else { setMenuItems(ALL_ITEMS); setMenuLoaded(true); }
  }, [menuLoaded]);

  const addToPreCart = (item) => {
    setPreCart(prev => {
      const ex = prev.find(i => i.id === item.id);
      if (ex) return prev.map(i => i.id === item.id ? { ...i, qty: i.qty + 1 } : i);
      return [...prev, { id: item.id, name: item.name, price: item.price, qty: 1 }];
    });
  };
  const removeFromPreCart = (id) => {
    setPreCart(prev => {
      const ex = prev.find(i => i.id === id);
      if (!ex) return prev;
      if (ex.qty === 1) return prev.filter(i => i.id !== id);
      return prev.map(i => i.id === id ? { ...i, qty: i.qty - 1 } : i);
    });
  };
  const preCartTotal = preCart.reduce((s, i) => s + i.price * i.qty, 0);
  const preCartCount = preCart.reduce((s, i) => s + i.qty, 0);

  // ── Real-time status subscription ──
  useEffect(() => {
    if (!resv?.id || !SUPABASE_READY) return;
    const ch = supabase.channel("resv-" + resv.id)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "reservations", filter: `id=eq.${resv.id}` }, (p) => {
        const updated = { ...resv, status: p.new.status };
        setResv(updated);
        localStorage.setItem(LS_RESERVATION, JSON.stringify(updated));
        // Chime on confirmed
        if (p.new.status === "confirmed") playChime("happy");
        if (p.new.status === "cancelled") playChime("sad");
      })
      .subscribe();
    return () => supabase.removeChannel(ch);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resv?.id]);

  const playChime = (type) => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (type === "happy") {
        [[523,0,0.15],[659,0.15,0.15],[784,0.3,0.2],[1047,0.5,0.3]].forEach(([f,s,d]) => {
          const o=ctx.createOscillator(), g=ctx.createGain();
          o.connect(g); g.connect(ctx.destination); o.frequency.value=f; o.type="sine";
          g.gain.setValueAtTime(0.2,ctx.currentTime+s); g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+s+d);
          o.start(ctx.currentTime+s); o.stop(ctx.currentTime+s+d);
        });
      } else {
        [[392,0,0.2],[349,0.22,0.2],[330,0.45,0.35]].forEach(([f,s,d]) => {
          const o=ctx.createOscillator(), g=ctx.createGain();
          o.connect(g); g.connect(ctx.destination); o.frequency.value=f; o.type="sine";
          g.gain.setValueAtTime(0.18,ctx.currentTime+s); g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+s+d);
          o.start(ctx.currentTime+s); o.stop(ctx.currentTime+s+d);
        });
      }
    } catch {}
    try { navigator.vibrate?.([60,30,60]); } catch {}
  };

  const today = new Date().toISOString().split("T")[0];

  const goStep2 = () => {
    if (!name.trim())            { setErr("Please enter your name."); return; }
    if (!/^\d{10}$/.test(phone)) { setErr("Enter a valid 10-digit phone number."); return; }
    if (!date)                   { setErr("Please select a date."); return; }
    if (!time)                   { setErr("Please select a time."); return; }
    setErr("");
    setStep(2);
  };

  const submit = async (skipPreOrder = false) => {
    setSaving(true);
    const items = skipPreOrder ? [] : preCart;
    const payload = { name: name.trim(), phone, date, time, guests, note: note.trim(), status: "pending", pre_order_items: items };
    if (SUPABASE_READY) {
      const { data, error } = await supabase.from("reservations").insert(payload).select().single();
      if (error) {
        setSaving(false);
        setErr("Couldn't save — " + error.message + ". Call us directly.");
        setStep(1);
        return;
      }
      const saved = { ...payload, id: data.id, created_at: data.created_at };
      localStorage.setItem(LS_RESERVATION, JSON.stringify(saved));
      setResv(saved);
    } else {
      // Offline / demo mode
      const saved = { ...payload, id: "demo-" + Date.now(), created_at: new Date().toISOString() };
      localStorage.setItem(LS_RESERVATION, JSON.stringify(saved));
      setResv(saved);
    }
    playChime("happy");
    setSaving(false);
  };

  const clearResv = () => {
    localStorage.removeItem(LS_RESERVATION);
    setResv(null);
    setStep(1);
    setDate(""); setTime(""); setNote(""); setErr(""); setPreCart([]);
  };

  // ── STATUS SCREENS ──────────────────────────────────────

  // Pending — beautiful "We got it, check back later" screen
  if (resv?.status === "pending") {
    const floaters = ["📅","🍔","✨","🌟","🎉","🍽️","⭐","🥂"];
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center relative overflow-hidden"
        style={{ background: "linear-gradient(160deg,#0a0a1a 0%,#0d1b3e 50%,#0a2040 100%)" }}>
        <style>{`
          @keyframes starFloat { 0%{transform:translateY(0) rotate(0deg);opacity:0} 10%{opacity:.4} 90%{opacity:.4} 100%{transform:translateY(-110vh) rotate(360deg);opacity:0} }
          @keyframes calPulse { 0%,100%{transform:scale(1) translateY(0)} 50%{transform:scale(1.07) translateY(-8px)} }
          @keyframes rsvSlide { from{opacity:0;transform:translateY(24px)} to{opacity:1;transform:translateY(0)} }
          .rsv1{animation:rsvSlide .5s .1s both} .rsv2{animation:rsvSlide .5s .25s both} .rsv3{animation:rsvSlide .5s .4s both} .rsv4{animation:rsvSlide .5s .55s both} .rsv5{animation:rsvSlide .5s .7s both}
        `}</style>

        {floaters.map((e,i) => (
          <span key={i} className="fixed text-xl select-none pointer-events-none" style={{
            left:`${5+i*13}%`, top:0,
            animation:`starFloat ${5+i*.8}s ${i*.5}s linear infinite`,
          }}>{e}</span>
        ))}

        {/* Big calendar icon */}
        <div className="rsv1 mb-6">
          <div className="w-28 h-28 rounded-3xl flex items-center justify-center text-6xl"
            style={{ background:"rgba(99,102,241,0.2)", border:"2px solid rgba(99,102,241,0.4)", animation:"calPulse 2.8s ease-in-out infinite" }}>
            📅
          </div>
        </div>

        <div className="rsv2 mb-2">
          <p className="text-3xl font-black text-white tracking-tight">We got your request!</p>
          <p className="text-base font-bold mt-1" style={{color:"#818cf8"}}>Hang tight, we'll confirm soon 🙏</p>
        </div>

        {/* Booking details card */}
        <div className="rsv3 w-full max-w-xs rounded-2xl p-4 my-4 text-left space-y-2"
          style={{ background:"rgba(255,255,255,0.07)", border:"1px solid rgba(255,255,255,0.12)" }}>
          <p className="text-[10px] font-black uppercase tracking-widest text-indigo-400 mb-3">Your Booking</p>
          {[
            ["👤 Name",   resv.name],
            ["📅 Date",   resv.date],
            ["🕐 Time",   resv.time],
            ["👥 Guests", `${resv.guests} ${resv.guests===1?"person":"people"}`],
          ].map(([l,v]) => (
            <div key={l} className="flex justify-between items-center">
              <span className="text-xs text-white/50">{l}</span>
              <span className="text-xs font-bold text-white">{v}</span>
            </div>
          ))}
          {resv.pre_order_items?.length > 0 && (
            <div className="pt-2 mt-2" style={{borderTop:"1px solid rgba(255,255,255,0.1)"}}>
              <p className="text-[10px] font-black uppercase tracking-widest text-orange-400 mb-2">Pre-ordered Food</p>
              {resv.pre_order_items.map(i => (
                <div key={i.id} className="flex justify-between text-xs text-white/70">
                  <span>{i.name} ×{i.qty}</span>
                  <span>₹{i.price * i.qty}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="rsv3 text-sm text-white/50 max-w-[260px] mb-5 leading-relaxed">
          Check back here or visit <span className="text-indigo-400 font-bold">burgerpoint.co.in</span> to see your booking status. We'll also call or WhatsApp you to confirm!
        </p>

        <a href={WHATSAPP} target="_blank" rel="noreferrer"
          className="rsv4 flex items-center gap-2 font-bold text-sm text-white px-6 py-3 rounded-2xl mb-3"
          style={{ background:"#22c55e", boxShadow:"0 6px 24px rgba(34,197,94,0.4)" }}>
          💬 Chat on WhatsApp
        </a>

        <button onClick={clearResv}
          className="rsv5 text-xs text-white/30 font-semibold px-4 py-2 rounded-xl mt-1"
          style={{ border:"1px solid rgba(255,255,255,0.1)" }}>
          Make a new booking
        </button>
        <p className="rsv5 mt-6 text-white/20 text-xs">Burger Point · burgerpoint.co.in</p>
      </div>
    );
  }

  // Confirmed — green celebration screen
  if (resv?.status === "confirmed") {
    const confetti = ["🎉","🎊","⭐","✨","🥂","🍾","🎈","💚"];
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center relative overflow-hidden"
        style={{ background:"linear-gradient(160deg,#052e16 0%,#14532d 50%,#166534 100%)" }}>
        <style>{`
          @keyframes confettiFall { 0%{transform:translateY(-40px) rotate(0deg);opacity:0} 10%{opacity:.5} 90%{opacity:.5} 100%{transform:translateY(110vh) rotate(540deg);opacity:0} }
          @keyframes checkPop { 0%{transform:scale(0) rotate(-20deg)} 60%{transform:scale(1.15) rotate(5deg)} 100%{transform:scale(1) rotate(0deg)} }
          .rsv1{animation:rsvSlide .5s .1s both} .rsv2{animation:rsvSlide .5s .3s both} .rsv3{animation:rsvSlide .5s .5s both} .rsv4{animation:rsvSlide .5s .7s both}
        `}</style>
        {confetti.map((e,i) => (
          <span key={i} className="fixed text-2xl select-none pointer-events-none" style={{ left:`${5+i*12}%`, top:0, animation:`confettiFall ${4+i*.6}s ${i*.4}s linear infinite` }}>{e}</span>
        ))}

        <div className="rsv1 mb-6">
          <div className="w-28 h-28 rounded-full flex items-center justify-center text-6xl"
            style={{ background:"rgba(34,197,94,0.25)", border:"2px solid rgba(34,197,94,0.5)", animation:"checkPop .6s .2s both ease-out" }}>
            ✅
          </div>
        </div>

        <div className="rsv2 mb-2">
          <p className="text-3xl font-black text-white">You're all set!</p>
          <p className="text-base font-bold mt-1 text-green-300">Your table is confirmed 🎉</p>
        </div>

        <div className="rsv3 w-full max-w-xs rounded-2xl p-4 my-4 text-left space-y-2"
          style={{ background:"rgba(255,255,255,0.08)", border:"1px solid rgba(34,197,94,0.3)" }}>
          <p className="text-[10px] font-black uppercase tracking-widest text-green-400 mb-3">Confirmed Booking</p>
          {[
            ["👤",resv.name],["📅",resv.date],["🕐",resv.time],["👥",`${resv.guests} ${resv.guests===1?"guest":"guests"}`],
          ].map(([e,v]) => (
            <div key={e} className="flex justify-between"><span className="text-xs text-white/50">{e}</span><span className="text-xs font-bold text-white">{v}</span></div>
          ))}
          {resv.pre_order_items?.length > 0 && (
            <div className="pt-2 mt-2" style={{borderTop:"1px solid rgba(34,197,94,0.2)"}}>
              <p className="text-[10px] font-black uppercase tracking-widest text-orange-400 mb-2">Pre-ordered — ready when you arrive 🍔</p>
              {resv.pre_order_items.map(i => (
                <div key={i.id} className="flex justify-between text-xs text-white/70"><span>{i.name} ×{i.qty}</span><span>₹{i.price*i.qty}</span></div>
              ))}
            </div>
          )}
        </div>

        <p className="rsv3 text-sm text-white/60 max-w-[260px] mb-5 leading-relaxed">
          See you soon! Your table and{resv.pre_order_items?.length ? " food" : ""} will be ready when you arrive. 🚶‍♂️
        </p>

        <a href={WHATSAPP} target="_blank" rel="noreferrer"
          className="rsv4 flex items-center gap-2 font-bold text-sm text-white px-6 py-3 rounded-2xl mb-3"
          style={{ background:"#15803d", boxShadow:"0 6px 24px rgba(21,128,61,0.4)" }}>
          💬 Message Us
        </a>
        <button onClick={clearResv} className="rsv4 text-xs text-white/30 font-semibold px-4 py-2 rounded-xl" style={{border:"1px solid rgba(255,255,255,0.1)"}}>
          Make another booking
        </button>
      </div>
    );
  }

  // Cancelled — reuse dark cancel aesthetic
  if (resv?.status === "cancelled") {
    const sadFoods = ["📅","🍔","😢","✖️","🚫","😔","💔","🙁"];
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center relative overflow-hidden"
        style={{ background:"linear-gradient(160deg,#1a1a2e 0%,#16213e 40%,#0f3460 100%)" }}>
        <style>{`
          @keyframes floatDown2{0%{transform:translateY(-60px) rotate(0deg);opacity:0}10%{opacity:.3}90%{opacity:.3}100%{transform:translateY(110vh) rotate(360deg);opacity:0}}
          @keyframes rsvSlide{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
          .rsv1{animation:rsvSlide .5s .1s both}
          .rsv2{animation:rsvSlide .5s .3s both}
          .rsv3{animation:rsvSlide .5s .5s both}
          .rsv4{animation:rsvSlide .5s .7s both}
          .rsv5{animation:rsvSlide .5s .9s both}
        `}</style>
        {sadFoods.map((e,i) => (
          <span key={i} className="fixed text-xl select-none pointer-events-none" style={{ left:`${6+i*11}%`, top:0, animation:`floatDown2 ${4.5+i*.7}s ${i*.55}s linear infinite` }}>{e}</span>
        ))}
        <div className="rsv1 mb-6">
          <div className="w-28 h-28 rounded-full flex items-center justify-center text-6xl"
            style={{ background:"rgba(239,68,68,0.15)", border:"2px solid rgba(239,68,68,0.35)" }}>
            📅
          </div>
          <div className="absolute -bottom-1 right-0 text-2xl" style={{marginTop:-20}}>❌</div>
        </div>
        <p className="text-3xl font-black text-white rsv1 mb-1">Booking declined</p>
        <p className="text-base font-bold text-red-400 rsv2 mb-4">Sorry we couldn't fit you in this time</p>
        <p className="text-sm text-white/50 max-w-[260px] rsv3 mb-6 leading-relaxed">
          We apologise! Please try a different date or time, or give us a call and we'll sort something out 🙏
        </p>
        <button onClick={clearResv}
          className="rsv4 w-full max-w-xs py-4 rounded-2xl font-black text-white mb-3"
          style={{ background:"linear-gradient(135deg,#f97316,#ef4444)", boxShadow:"0 8px 32px rgba(249,115,22,0.45)" }}>
          📅 Try Another Date
        </button>
        <a href="tel:+919194008822" className="rsv5 flex items-center justify-center gap-2 text-white/40 text-xs font-bold py-2 px-4 rounded-xl" style={{border:"1px solid rgba(255,255,255,0.12)"}}>
          <Phone size={12} /> Call Us
        </a>
      </div>
    );
  }

  // ── FORM SCREENS ─────────────────────────────────────────

  const menuByCategory = menuItems.filter(i => i.category === menuCat);
  const cats = [...new Set(menuItems.map(i => i.category))].slice(0, 8);

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 to-amber-50">

      {/* Header */}
      <div className="sticky top-0 z-20 bg-white/90 backdrop-blur border-b border-orange-100 px-4 py-3 flex items-center gap-3">
        <button onClick={() => step === 2 ? setStep(1) : (window.location.hash = "")}
          className="w-9 h-9 rounded-xl bg-stone-100 flex items-center justify-center">
          <ArrowLeft size={15} className="text-stone-600" />
        </button>
        <div className="flex-1">
          <p className="font-black text-stone-800 text-sm">Book a Table</p>
          <p className="text-[10px] text-stone-400">Step {step} of 2 — {step===1?"Your Details":"Pre-order Food (optional)"}</p>
        </div>
        {/* Step dots */}
        <div className="flex gap-1.5">
          {[1,2].map(s => (
            <div key={s} className="w-6 h-1.5 rounded-full transition-all" style={{ background: s <= step ? "#f97316" : "#e7e5e4" }} />
          ))}
        </div>
      </div>

      <div className="max-w-sm mx-auto px-4 py-6 pb-32">

        {/* ── STEP 1: Basic info ── */}
        {step === 1 && (
          <div className="space-y-4">
            <div className="bg-white rounded-3xl border border-orange-100 p-5 shadow-sm">
              <p className="text-xs font-black text-orange-500 uppercase tracking-widest mb-4">Your Details</p>
              <div className="space-y-3">
                <div>
                  <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Name *</label>
                  <div className="relative">
                    <User size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
                    <input value={name} onChange={e => { setName(e.target.value); setErr(""); }} placeholder="Your name"
                      className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-2xl pl-9 pr-4 py-3 outline-none text-stone-700" />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Phone *</label>
                  <div className="relative">
                    <Phone size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
                    <input value={phone} onChange={e => { setPhone(e.target.value.replace(/\D/g,"").slice(0,10)); setErr(""); }} placeholder="10-digit number" inputMode="numeric"
                      className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-2xl pl-9 pr-4 py-3 outline-none text-stone-700" />
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-3xl border border-orange-100 p-5 shadow-sm">
              <p className="text-xs font-black text-orange-500 uppercase tracking-widest mb-4">Reservation Details</p>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Date *</label>
                    <input type="date" value={date} min={today} onChange={e => { setDate(e.target.value); setErr(""); }}
                      className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-2xl px-3 py-3 outline-none text-stone-700" />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Time *</label>
                    <select value={time} onChange={e => { setTime(e.target.value); setErr(""); }}
                      className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-2xl px-3 py-3 outline-none text-stone-700">
                      <option value="">Select…</option>
                      {["11:00 AM","12:00 PM","1:00 PM","2:00 PM","3:00 PM","4:00 PM","5:00 PM","6:00 PM","7:00 PM","8:00 PM","9:00 PM","10:00 PM"].map(t=>(
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Guests</label>
                  <div className="flex items-center gap-3 bg-stone-50 rounded-2xl px-4 py-2.5 border-2 border-stone-200">
                    <button onClick={() => setGuests(g=>Math.max(1,g-1))} className="w-8 h-8 rounded-xl bg-white border border-stone-200 flex items-center justify-center">
                      <Minus size={13} className="text-stone-600" />
                    </button>
                    <span className="flex-1 text-center text-sm font-black text-stone-800">{guests} {guests===1?"person":"people"}</span>
                    <button onClick={() => setGuests(g=>Math.min(20,g+1))} className="w-8 h-8 rounded-xl bg-orange-500 flex items-center justify-center">
                      <Plus size={13} className="text-white" />
                    </button>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Special Note</label>
                  <textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="Birthday, anniversary, dietary needs, seating preference…"
                    className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-2xl px-4 py-3 outline-none text-stone-700 resize-none h-20" />
                </div>
              </div>
            </div>

            {err && <p className="text-red-500 text-xs text-center">{err}</p>}
          </div>
        )}

        {/* ── STEP 2: Pre-order food ── */}
        {step === 2 && (
          <div>
            <div className="bg-white rounded-3xl border border-orange-100 p-4 mb-4 shadow-sm">
              <p className="text-xs font-black text-orange-500 uppercase tracking-widest mb-1">Pre-order Your Dinner</p>
              <p className="text-xs text-stone-400 leading-relaxed">Skip the wait — tell us what you'd like and it'll be ready when you arrive. You can always order more at the table!</p>
            </div>

            {/* Category pills */}
            <div className="flex gap-2 overflow-x-auto pb-2 mb-3" style={{scrollbarWidth:"none"}}>
              {cats.map(c => {
                const cat = [{id:"burgers",emoji:"🍔"},{id:"grilled",emoji:"🌿"},{id:"pizza",emoji:"🍕"},{id:"pasta",emoji:"🍝"},{id:"sandwiches",emoji:"🥪"},{id:"wraps",emoji:"🌯"},{id:"chinese",emoji:"🥡"},{id:"noodles",emoji:"🍜"},{id:"rice",emoji:"🍚"},{id:"momos",emoji:"🥟"},{id:"quickbites",emoji:"🍟"},{id:"shakes",emoji:"🥤"},{id:"mocktails",emoji:"🍹"}].find(x=>x.id===c);
                return (
                  <button key={c} onClick={()=>setMenuCat(c)}
                    className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${menuCat===c?"bg-orange-500 text-white":"bg-white border border-stone-200 text-stone-600"}`}>
                    {cat?.emoji} {c.charAt(0).toUpperCase()+c.slice(1)}
                  </button>
                );
              })}
            </div>

            {/* Menu items */}
            <div className="space-y-2 mb-4">
              {menuByCategory.map(item => {
                const inCart = preCart.find(i=>i.id===item.id);
                return (
                  <div key={item.id} className="bg-white rounded-2xl border border-stone-100 px-4 py-3 flex items-center gap-3 shadow-sm">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-stone-800 truncate">{item.name}</p>
                      <p className="text-xs font-bold text-orange-500">₹{item.price}</p>
                    </div>
                    {inCart ? (
                      <div className="flex items-center gap-2">
                        <button onClick={()=>removeFromPreCart(item.id)} className="w-7 h-7 rounded-lg bg-stone-100 flex items-center justify-center">
                          <Minus size={12} className="text-stone-600" />
                        </button>
                        <span className="text-sm font-black text-stone-800 w-4 text-center">{inCart.qty}</span>
                        <button onClick={()=>addToPreCart(item)} className="w-7 h-7 rounded-lg bg-orange-500 flex items-center justify-center">
                          <Plus size={12} className="text-white" />
                        </button>
                      </div>
                    ) : (
                      <button onClick={()=>addToPreCart(item)} className="w-8 h-8 rounded-xl bg-orange-50 border border-orange-200 flex items-center justify-center active:scale-90 transition-transform">
                        <Plus size={14} className="text-orange-500" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Pre-cart summary */}
            {preCartCount > 0 && (
              <div className="bg-white rounded-2xl border border-orange-200 p-4 mb-2">
                <p className="text-xs font-black text-orange-500 uppercase tracking-widest mb-2">Your Pre-order ({preCartCount} items)</p>
                {preCart.map(i=>(
                  <div key={i.id} className="flex justify-between text-xs text-stone-700 py-0.5">
                    <span>{i.name} ×{i.qty}</span><span className="font-bold">₹{i.price*i.qty}</span>
                  </div>
                ))}
                <div className="flex justify-between text-sm font-black text-stone-800 pt-2 mt-2 border-t border-stone-100">
                  <span>Total</span><span className="text-orange-500">₹{preCartTotal}</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sticky bottom CTA */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-stone-100 px-4 py-3 safe-bottom">
        <div className="max-w-sm mx-auto space-y-2">
          {step === 1 ? (
            <button onClick={goStep2} disabled={saving}
              className="w-full py-4 rounded-2xl font-black text-white text-sm shadow-lg active:scale-95 transition-transform"
              style={{ background:"linear-gradient(135deg,#f97316,#ef4444)" }}>
              Next: Pre-order Food →
            </button>
          ) : (
            <>
              <button onClick={()=>submit(false)} disabled={saving}
                className="w-full py-3.5 rounded-2xl font-black text-white text-sm active:scale-95 transition-transform"
                style={{ background:"linear-gradient(135deg,#f97316,#ef4444)" }}>
                {saving ? "Booking…" : `📅 Confirm Booking${preCartCount > 0 ? ` + Pre-order (₹${preCartTotal})` : ""}`}
              </button>
              <button onClick={()=>submit(true)} disabled={saving}
                className="w-full py-2.5 rounded-2xl text-xs font-bold text-stone-500 bg-stone-50 border border-stone-200 active:scale-95 transition-transform">
                Skip food — just the table
              </button>
            </>
          )}
          <p className="text-[10px] text-stone-400 text-center">We'll confirm via WhatsApp or phone within 30 mins</p>
        </div>
      </div>
    </div>
  );
}

// ── PRIVACY PAGE ──────────────────────────────────────────
export function PrivacyPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 to-amber-50">
      <div className="max-w-2xl mx-auto px-5 py-8">
        <button onClick={() => window.history.back()} className="flex items-center gap-2 text-stone-500 text-sm mb-6 hover:text-orange-600 transition-colors"><ArrowLeft size={15} /> Back</button>
        <div className="bg-white rounded-3xl p-6 shadow-sm border border-orange-100">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-blue-100 rounded-2xl flex items-center justify-center"><Shield size={22} className="text-blue-600" /></div>
            <div><h1 className="font-black text-stone-800 text-xl">Privacy Policy</h1><p className="text-xs text-stone-400">Burger Point · Last updated: July 2025</p></div>
          </div>
          {[
            { t: "Information We Collect", b: "We collect your name, phone number, and delivery address only when you place a delivery or takeaway order. For dine-in, no personal information is required. We also collect your order details to process your order." },
            { t: "How We Use Your Information", b: "Your information is used solely to process and deliver your order. We use your phone number to contact you if needed. Your address is used only for routing delivery. We do not use your data for marketing without consent." },
            { t: "Data Sharing", b: "We share your name and phone with our delivery riders only when needed to complete your delivery. We never sell or share your personal information with third parties for marketing purposes." },
            { t: "Payment Security", b: "Payments processed through Razorpay are encrypted end-to-end using 256-bit SSL. We do not store card numbers, CVV, or UPI credentials on our servers." },
            { t: "Data Storage", b: "Your order data is stored securely for up to 90 days for business purposes and then deleted. We do not store payment instrument details." },
            { t: "Your Rights", b: "You have the right to request deletion of your personal data. Contact us via WhatsApp at +91 91940 08822. We will process your request within 7 business days." },
          ].map((s, i) => (
            <div key={i} className="mb-5">
              <h2 className="font-bold text-stone-800 text-sm mb-2">{i + 1}. {s.t}</h2>
              <p className="text-sm text-stone-600 leading-relaxed">{s.b}</p>
            </div>
          ))}
          <div className="bg-orange-50 rounded-2xl p-4 border border-orange-100">
            <p className="text-xs font-bold text-orange-800 mb-1">Contact for Privacy Concerns</p>
            <p className="text-xs text-stone-600">WhatsApp: <a href="https://wa.me/919194008822" className="text-orange-600 font-semibold">+91 91940 08822</a></p>
            <p className="text-xs text-stone-600 mt-0.5">Email: <a href="mailto:burgerpoint.lko@gmail.com" className="text-orange-600 font-semibold">burgerpoint.lko@gmail.com</a></p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── CONTACT PAGE ──────────────────────────────────────────
export function ContactPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 to-amber-50">
      <div className="max-w-2xl mx-auto px-5 py-8">
        <button onClick={() => window.history.back()} className="flex items-center gap-2 text-stone-500 text-sm mb-6 hover:text-orange-600 transition-colors"><ArrowLeft size={15} /> Back</button>
        <div className="bg-white rounded-3xl p-6 shadow-sm border border-orange-100">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-orange-100 rounded-2xl flex items-center justify-center text-2xl">🍔</div>
            <div><h1 className="font-black text-stone-800 text-xl">Contact Us</h1><p className="text-xs text-stone-400">We'd love to hear from you</p></div>
          </div>
          <div className="space-y-3">
            {[
              { icon: "📍", label: "Address", val: "Shop 647/020-CC, 60 Feet Road, Jankipuram, Lucknow, UP — 226021", href: "https://maps.google.com/?q=Burger+Point+Jankipuram+Lucknow", linkText: "Get Directions" },
              { icon: "📞", label: "Phone", val: "+91 91940 08822", href: "tel:+919194008822" },
              { icon: "💬", label: "WhatsApp", val: "Chat with us on WhatsApp", href: WHATSAPP },
              { icon: "📸", label: "Instagram", val: "@burgerpoint_as", href: INSTAGRAM },
              { icon: "🕐", label: "Opening Hours", val: "Mon – Sun: 11:00 AM – 10:30 PM", href: null },
            ].map((c, i) => (
              <div key={i} className="flex items-start gap-4 bg-stone-50 rounded-2xl p-4">
                <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-xl flex-shrink-0 shadow-sm">{c.icon}</div>
                <div className="flex-1">
                  <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest">{c.label}</p>
                  <p className="text-sm text-stone-700 mt-0.5">{c.val}</p>
                  {c.href && <a href={c.href} target={c.href.startsWith("http") ? "_blank" : "_self"} rel="noreferrer" className="text-xs text-orange-500 font-semibold mt-1 inline-block">{c.linkText || "Open →"}</a>}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-5 bg-gradient-to-r from-orange-500 to-red-500 rounded-2xl p-4 text-white text-center">
            <p className="font-bold text-sm">Quick Query?</p>
            <p className="text-xs text-orange-100 mt-1 mb-3">We respond within 30 mins during working hours</p>
            <a href="https://wa.me/919194008822?text=Hi%20Burger%20Point%2C%20I%20have%20a%20query..." target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-2 bg-white text-orange-600 font-bold text-sm px-5 py-2.5 rounded-xl shadow-sm">
              💬 WhatsApp Us Now
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

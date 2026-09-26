// ─────────────────────────────────────────────────────────
//  RiderApp.jsx — Burger Point Rider Dashboard
//  Mobile-first. Large buttons. One-handed usage.
// ─────────────────────────────────────────────────────────
import { useState, useEffect, useRef, useCallback } from "react";
import {
  Home, Clock, User, MapPin, Phone, Package,
  CheckCircle, Navigation2, LogOut, RefreshCw,
  Search, Eye, EyeOff, Wifi, WifiOff,
  ChevronDown, ChevronUp, TrendingUp, IndianRupee, Lock,
} from "lucide-react";
import { supabase } from "./supabase.js";
import { SUPABASE_READY } from "./constants.js";
import { useToast, RiderCardSkeleton } from "./ui.jsx";
import { useBusinessSettings } from "./useBusinessSettings.js";

const LS_RIDER = "bp_rider_session";
const currency = n => `₹${Number(n || 0).toLocaleString("en-IN")}`;
const fmt = d => new Date(d).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" });

// ── Rider notification chime (different from admin) ───────
function playRiderChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const doPlay = () => {
      const master = ctx.createGain(); master.gain.value = 0.7; master.connect(ctx.destination);
      const note = (f, t, d) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.connect(g); g.connect(master); o.type = "sine";
        o.frequency.setValueAtTime(f, ctx.currentTime + t);
        g.gain.setValueAtTime(0, ctx.currentTime + t);
        g.gain.linearRampToValueAtTime(0.8, ctx.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + d);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + d + 0.02);
      };
      note(880, 0, 0.12); note(1174, 0.12, 0.12);
      note(1318, 0.24, 0.12); note(1760, 0.36, 0.5);
    };
    if (ctx.state === "suspended") {
      ctx.resume().then(doPlay).catch(() => {});
    } else {
      doPlay();
    }
  } catch {}
}

// ── Notification hook for new assignments ─────────────────
function useRiderNotifications(riderId, currentOrders, authed) {
  const prevIdsRef      = useRef(new Set());
  const isFirstLoadRef  = useRef(true);
  const repeatRef       = useRef(null);
  const flashRef        = useRef(null);
  const [popup, setPopup]       = useState(null);
  const [unread, setUnread]     = useState(0);
  const unackedRef              = useRef(new Set());

  useEffect(() => {
    // Native browser Notification permission request removed — it was
    // crashing the rider app to a blank screen on some mobile browsers/
    // webviews that don't implement the Notification API cleanly. The
    // in-app popup + chime + title flash below are enough on their own.
  }, [authed]);

  const startFlash = useCallback((n) => {
    clearInterval(flashRef.current);
    const orig = "Burger Point Rider"; let vis = true;
    flashRef.current = setInterval(() => {
      document.title = vis ? `🛵 ${n} New Order!` : orig; vis = !vis;
    }, 700);
    setTimeout(() => { clearInterval(flashRef.current); document.title = "Burger Point Rider"; }, 12000);
  }, []);

  const stopAll = useCallback(() => {
    unackedRef.current.clear(); setUnread(0); setPopup(null);
    clearInterval(repeatRef.current); clearInterval(flashRef.current);
    document.title = "Burger Point Rider";
  }, []);

  useEffect(() => {
    const assigned = currentOrders.filter(o => o.rider_status === "assigned");

    // On first load after login, seed prevIds without notifying —
    // orders already assigned before login are not "new"
    if (isFirstLoadRef.current) {
      prevIdsRef.current = new Set(assigned.map(o => o.id));
      isFirstLoadRef.current = false;
      return;
    }

    const newOnes  = assigned.filter(o => !prevIdsRef.current.has(o.id));

    if (newOnes.length > 0) {
      newOnes.forEach(o => unackedRef.current.add(o.id));
      setUnread(unackedRef.current.size);
      setPopup(newOnes[0]);
      playRiderChime();
      startFlash(unackedRef.current.size);
      clearInterval(repeatRef.current);
      repeatRef.current = setInterval(() => {
        if (unackedRef.current.size > 0) { playRiderChime(); startFlash(unackedRef.current.size); }
        else clearInterval(repeatRef.current);
      }, 15000);
    }

    prevIdsRef.current = new Set(assigned.map(o => o.id));
  }, [currentOrders, startFlash]);

  useEffect(() => () => {
    clearInterval(repeatRef.current); clearInterval(flashRef.current);
    document.title = "Burger Point Rider";
  }, []);

  const acknowledge = useCallback(() => stopAll(), [stopAll]);
  return { popup, unread, acknowledge };
}

// ── Status badge ──────────────────────────────────────────
const STATUS = {
  assigned:  { label: "Assigned",   color: "bg-blue-100 text-blue-700",    icon: "📋" },
  accepted:  { label: "Accepted",   color: "bg-orange-100 text-orange-700", icon: "✅" },
  picked_up: { label: "Picked Up",  color: "bg-purple-100 text-purple-700", icon: "📦" },
  delivered: { label: "Delivered",  color: "bg-green-100 text-green-700",   icon: "🎉" },
};

const AVAIL_CFG = {
  Available: { color: "bg-green-500",  label: "Available" },
  Busy:      { color: "bg-orange-500", label: "Busy" },
  Offline:   { color: "bg-stone-400",  label: "Offline" },
};

// ── New order popup — CSS-only slide-in, no animation library ──
function NewOrderPopup({ order, onAck }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (order) {
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
  }, [order]);

  if (!order) return null;
  return (
    <div
      className="fixed top-4 left-1/2 -translate-x-1/2 z-[999] w-full max-w-sm px-4"
      style={{
        transform: `translate(-50%, ${visible ? "0" : "-80px"})`,
        opacity: visible ? 1 : 0,
        transition: "transform 0.2s ease-out, opacity 0.2s ease-out",
      }}>
      <div className="bg-white rounded-2xl shadow-2xl border-2 border-orange-500 overflow-hidden">
        <div className="bg-gradient-to-r from-orange-500 to-red-500 px-4 py-3 flex items-center gap-2">
          <span className="text-lg leading-none">🔔</span>
          <span className="text-white font-black text-sm">🛵 NEW DELIVERY ASSIGNED!</span>
        </div>
        <div className="px-4 py-3">
          <p className="font-bold text-stone-800">{order.customer_name || "Customer"}</p>
          <p className="text-xs text-stone-500 mt-0.5">📍 {order.delivery_address || "Address not set"}</p>
          <p className="text-sm font-black text-orange-600 mt-1">{currency(order.total)}</p>
          <button onClick={onAck}
            className="w-full mt-3 bg-gradient-to-r from-orange-500 to-red-500 text-white font-bold py-3 rounded-xl text-sm active:scale-95 transition-transform">
            ✓ Got It — View Order
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Order card (full detail) — CSS-only expand, sticky action, always-visible call ──
function OrderCard({ order, onAction, actionLabel, actionColor, actionDisabled }) {
  const [open, setOpen] = useState(false);
  const cfg = STATUS[order.rider_status] || STATUS.assigned;

  const navigate = () => {
    if (order.customer_lat && order.customer_lng)
      window.open(`https://maps.google.com/?q=${order.customer_lat},${order.customer_lng}`, "_blank");
    else if (order.delivery_address)
      window.open(`https://maps.google.com/?q=${encodeURIComponent(order.delivery_address)}`, "_blank");
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-stone-100 overflow-hidden mb-3">

      {/* Always-visible summary row */}
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-start gap-3">
          <span className="text-2xl mt-0.5">{cfg.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-bold text-stone-800 text-sm">{order.customer_name || "Customer"}</p>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${cfg.color}`}>{cfg.label}</span>
            </div>
            <p className="text-xs text-stone-400 mt-0.5">📍 {order.delivery_address || "—"}</p>
            <div className="flex items-center gap-3 mt-0.5 flex-wrap">
              <span className="text-xs font-black text-orange-600">{currency(order.total)}</span>
              <span className="text-xs text-stone-400">{order.payment_method || "Cash"}</span>
            </div>
          </div>
          {order.customer_phone && (
            <a href={`tel:${order.customer_phone}`}
              className="flex-shrink-0 w-11 h-11 flex items-center justify-center bg-green-500 text-white rounded-xl active:scale-95 transition-transform">
              <Phone size={16} />
            </a>
          )}
        </div>

        {/* Expand toggle — full-width tap target, clearly labelled */}
        <button
          onClick={() => setOpen(o => !o)}
          className="mt-2 w-full flex items-center justify-center gap-1.5 py-2 rounded-xl bg-stone-50 text-stone-400 text-xs font-bold active:bg-stone-100 transition-colors">
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {open ? "Hide details" : "View order details"}
        </button>
      </div>

      {/* Inline expanded details — stacks vertically, no horizontal movement */}
      {open && (
        <div className="px-4 pb-3 border-t border-stone-50 pt-3 space-y-3">
          {/* Items */}
          <div className="bg-stone-50 rounded-xl p-3">
            <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-2">Items</p>
            {(order.items || []).map((it, i) => (
              <div key={i} className="flex justify-between text-sm py-1">
                <span className="text-stone-700">
                  {it.name}{it.selectedVariant ? ` (${it.selectedVariant})` : ""} ×{it.qty}
                  {it.addonLabels?.length > 0 && <span className="text-[11px] text-orange-400 ml-1">({it.addonLabels.join(", ")})</span>}
                </span>
                <span className="font-bold text-stone-600">{currency(it.finalPrice * it.qty)}</span>
              </div>
            ))}
            <div className="flex justify-between font-black text-sm pt-2 border-t border-stone-200 mt-1">
              <span>Total</span><span className="text-orange-600">{currency(order.total)}</span>
            </div>
          </div>

          {/* Navigate */}
          <button onClick={navigate}
            className="w-full flex items-center justify-center gap-2 bg-blue-500 text-white font-bold py-3 rounded-xl text-sm active:scale-95 transition-transform">
            <Navigation2 size={15} /> Navigate
          </button>

          {/* Note */}
          {order.note && (
            <div className="bg-yellow-50 rounded-xl px-3 py-2">
              <p className="text-xs text-stone-500 italic">📝 "{order.note}"</p>
            </div>
          )}
        </div>
      )}

      {/* Action button */}
      {actionLabel && (
        <div className="px-4 pb-4 pt-2 bg-white border-t border-stone-50">
          <button onClick={() => onAction(order.id)} disabled={actionDisabled}
            className={`w-full py-4 rounded-2xl font-black text-base text-white shadow-md active:scale-95 transition-transform disabled:opacity-50 ${actionColor || "bg-gradient-to-r from-orange-500 to-red-500"}`}>
            {actionLabel}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Home Tab ──────────────────────────────────────────────
function HomeTab({ rider, orders, onAction, onRefresh, loading, earningPerKm }) {
  const today = new Date().toISOString().split("T")[0];
  const todayDeliveries = orders.filter(o => o.rider_status === "delivered" && o.delivered_at?.slice(0, 10) === today);
  // Earnings = distance_km × earning_per_km; fallback to 0 if distance unknown
  const todayEarnings = todayDeliveries.reduce((s, o) => {
    const km = Number(o.delivery_distance_km || 0);
    return s + (km > 0 ? km * earningPerKm : 0);
  }, 0);
  const activeOrder = orders.find(o => ["assigned", "accepted", "picked_up"].includes(o.rider_status));

  const getAction = (o) => {
    if (o.rider_status === "assigned")  return { label: "✅ Accept Order",   color: "bg-gradient-to-r from-blue-500 to-blue-600" };
    if (o.rider_status === "accepted")  return { label: "📦 Mark Picked Up", color: "bg-gradient-to-r from-purple-500 to-purple-600" };
    if (o.rider_status === "picked_up") return { label: "🎉 Mark Delivered", color: "bg-gradient-to-r from-green-500 to-green-600" };
    return null;
  };

  return (
    <div className="px-4 py-4 space-y-4">
      {/* Stats row */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-gradient-to-br from-orange-500 to-red-500 rounded-2xl p-4 text-white">
          <p className="text-xs font-bold opacity-80">Today's Deliveries</p>
          <p className="text-3xl font-black mt-1">{todayDeliveries.length}</p>
        </div>
        <div className="bg-gradient-to-br from-green-500 to-emerald-600 rounded-2xl p-4 text-white">
          <p className="text-xs font-bold opacity-80">Today's Value</p>
          <p className="text-3xl font-black mt-1">₹{Math.round(todayEarnings)}</p>
        </div>
      </div>

      {/* Active order */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-bold text-stone-500 uppercase tracking-widest">Current Order</p>
          <button onClick={onRefresh} disabled={loading}
            className="w-7 h-7 rounded-lg bg-stone-100 flex items-center justify-center">
            <RefreshCw size={12} className={`text-stone-500 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
        {loading && orders.length === 0 ? (
          <div className="space-y-3">
            <RiderCardSkeleton />
            <RiderCardSkeleton />
          </div>
        ) : activeOrder ? (() => {
          const act = getAction(activeOrder);
          return (
            <OrderCard order={activeOrder} onAction={onAction}
              actionLabel={act?.label} actionColor={act?.color} />
          );
        })() : (
          <div className="bg-stone-50 rounded-2xl p-8 text-center border-2 border-dashed border-stone-200">
            <p className="text-4xl mb-2">🛵</p>
            <p className="font-bold text-stone-500">No active delivery</p>
            <p className="text-xs text-stone-400 mt-1">New orders will appear here</p>
          </div>
        )}
      </div>

      {/* Pending assigned orders (queue) */}
      {orders.filter(o => o.rider_status === "assigned" && o.id !== activeOrder?.id).length > 0 && (
        <div>
          <p className="text-xs font-bold text-stone-500 uppercase tracking-widest mb-2">Queue</p>
          {orders.filter(o => o.rider_status === "assigned" && o.id !== activeOrder?.id).map(o => {
            const act = getAction(o);
            return <OrderCard key={o.id} order={o} onAction={onAction} actionLabel={act?.label} actionColor={act?.color} />;
          })}
        </div>
      )}
    </div>
  );
}

// ── History Order Row — tap to expand full order details ──
function HistoryOrderRow({ order, earningPerKm }) {
  const [open, setOpen] = useState(false);
  const km     = Number(order.delivery_distance_km || 0);
  const earned = km > 0 ? Math.round(km * earningPerKm) : null;

  return (
    <div className="bg-white rounded-2xl border border-stone-100 overflow-hidden">
      {/* Summary row — always visible, tap anywhere to expand */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full text-left px-4 py-3 flex items-center justify-between active:bg-stone-50 transition-colors">
        <div className="flex-1 min-w-0">
          <p className="font-bold text-stone-800 text-sm">{order.customer_name || "Customer"}</p>
          <p className="text-xs text-stone-400 mt-0.5">{order.delivered_at ? fmt(order.delivered_at) : "—"}</p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0 ml-3">
          <div className="text-right">
            <p className="font-black text-orange-600 text-sm">{currency(order.total)}</p>
            {earned !== null
              ? <p className="text-xs font-bold text-green-600">₹{earned} earned</p>
              : <p className="text-xs text-stone-400">Dist. unknown</p>}
          </div>
          {open ? <ChevronUp size={14} className="text-stone-300" /> : <ChevronDown size={14} className="text-stone-300" />}
        </div>
      </button>

      {/* Expanded details — full order info, stacks vertically */}
      {open && (
        <div className="border-t border-stone-100 px-4 pb-4 pt-3 space-y-3">

          {/* Address */}
          <div className="flex items-start gap-2">
            <span className="text-base mt-0.5">📍</span>
            <p className="text-sm text-stone-600">{order.delivery_address || "—"}</p>
          </div>

          {/* Distance + payment */}
          <div className="flex gap-3">
            {km > 0 && (
              <span className="text-xs bg-blue-50 text-blue-600 font-bold px-3 py-1 rounded-full">
                📏 {km.toFixed(1)} km
              </span>
            )}
            <span className="text-xs bg-stone-100 text-stone-500 font-bold px-3 py-1 rounded-full">
              {order.payment_method || "Cash"}
            </span>
            <span className="text-xs bg-green-100 text-green-700 font-bold px-3 py-1 rounded-full">✓ Delivered</span>
          </div>

          {/* Items */}
          <div className="bg-stone-50 rounded-xl p-3">
            <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-2">Items</p>
            {(order.items || []).map((it, i) => (
              <div key={i} className="flex justify-between text-sm py-1">
                <span className="text-stone-700">
                  {it.name}{it.selectedVariant ? ` (${it.selectedVariant})` : ""} ×{it.qty}
                  {it.addonLabels?.length > 0 && (
                    <span className="text-[11px] text-orange-400 ml-1">({it.addonLabels.join(", ")})</span>
                  )}
                </span>
                <span className="font-bold text-stone-600">{currency(it.finalPrice * it.qty)}</span>
              </div>
            ))}
            <div className="flex justify-between font-black text-sm pt-2 border-t border-stone-200 mt-1">
              <span>Total</span>
              <span className="text-orange-600">{currency(order.total)}</span>
            </div>
          </div>

          {/* Note */}
          {order.note && (
            <div className="bg-yellow-50 rounded-xl px-3 py-2">
              <p className="text-xs text-stone-500 italic">📝 "{order.note}"</p>
            </div>
          )}

          {/* Earnings callout */}
          {earned !== null && (
            <div className="bg-green-50 rounded-xl px-3 py-2.5 flex items-center justify-between">
              <p className="text-xs font-bold text-green-700">Your earnings</p>
              <p className="font-black text-green-600">₹{earned}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Account Tab — merged History + Profile ───────────────
function AccountTab({ rider, orders, availability, onAvailChange, onLogout, earningPerKm }) {
  const [section, setSection] = useState("history"); // "history" | "profile"
  const [search, setSearch]   = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [showPwd, setShowPwd]   = useState(false);
  const [oldPwd, setOldPwd]     = useState("");
  const [newPwd, setNewPwd]     = useState("");
  const [pwdMsg, setPwdMsg]     = useState("");
  const [pwdLoading, setPwdLoading] = useState(false);

  const delivered = orders.filter(o => o.rider_status === "delivered").sort((a, b) => new Date(b.delivered_at) - new Date(a.delivered_at));
  const filtered  = delivered.filter(o => {
    const matchSearch = !search || (o.customer_name || "").toLowerCase().includes(search.toLowerCase()) || (o.customer_phone || "").includes(search);
    const matchDate   = !dateFilter || (o.delivered_at || "").slice(0, 10) === dateFilter;
    return matchSearch && matchDate;
  });
  const totalEarned = filtered.reduce((s, o) => {
    const km = Number(o.delivery_distance_km || 0);
    return s + (km > 0 ? km * earningPerKm : 0);
  }, 0);

  const totalDeliveries = delivered.length;
  const today = new Date().toISOString().split("T")[0];
  const todayDeliveries = delivered.filter(o => o.delivered_at?.slice(0, 10) === today).length;

  const changePwd = async () => {
    if (!oldPwd || !newPwd) { setPwdMsg("Fill both fields."); return; }
    if (newPwd.length < 6)  { setPwdMsg("New password min 6 chars."); return; }
    setPwdLoading(true); setPwdMsg("");
    const { data } = await supabase.rpc("verify_rider_login", { p_rider_id: rider.rider_id, p_password: oldPwd });
    if (!data?.success) { setPwdMsg("Old password incorrect."); setPwdLoading(false); return; }
    const { data: ok } = await supabase.rpc("reset_rider_password", { p_rider_id: rider.rider_id, p_new_password: newPwd });
    setPwdLoading(false);
    if (ok) { setPwdMsg("✅ Password changed!"); setOldPwd(""); setNewPwd(""); }
    else setPwdMsg("❌ Failed. Try again.");
  };

  return (
    <div className="px-4 py-4">
      {/* Rider summary — always visible at top of account tab */}
      <div className="bg-gradient-to-br from-orange-500 to-red-600 rounded-3xl p-4 text-white mb-4 flex items-center gap-4">
        <div className="w-14 h-14 bg-white/20 rounded-full flex items-center justify-center text-2xl flex-shrink-0">🛵</div>
        <div className="flex-1 min-w-0">
          <p className="font-black text-lg leading-tight truncate">{rider.full_name}</p>
          <p className="text-orange-100 text-sm">{rider.phone_number}</p>
          <p className="text-orange-200 text-xs">ID: {rider.rider_id}</p>
        </div>
        <div className="flex-shrink-0 text-right">
          <p className="font-black text-2xl">{totalDeliveries}</p>
          <p className="text-orange-100 text-xs">total</p>
          <p className="font-black text-lg">{todayDeliveries}</p>
          <p className="text-orange-200 text-xs">today</p>
        </div>
      </div>

      {/* Section toggle */}
      <div className="flex bg-stone-100 rounded-2xl p-1 mb-4">
        {[{ id: "history", label: "📦 History" }, { id: "profile", label: "⚙️ Settings" }].map(s => (
          <button key={s.id} onClick={() => setSection(s.id)}
            className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${section === s.id ? "bg-white text-stone-800 shadow-sm" : "text-stone-400"}`}>
            {s.label}
          </button>
        ))}
      </div>

      {/* ── History section ── */}
      {section === "history" && (
        <div>
          <div className="flex gap-2 mb-4">
            <div className="flex-1 flex items-center gap-2 bg-stone-100 rounded-xl px-3 py-2.5">
              <Search size={13} className="text-stone-400 flex-shrink-0" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search customer…"
                className="flex-1 bg-transparent text-sm outline-none text-stone-700" />
            </div>
            <input type="date" value={dateFilter} onChange={e => setDateFilter(e.target.value)}
              className="text-xs border-2 border-stone-200 rounded-xl px-2 outline-none text-stone-600" />
          </div>

          {filtered.length === 0 ? (
            <div className="text-center py-16">
              <p className="text-4xl mb-3">📦</p>
              <p className="text-stone-400 text-sm">No deliveries found</p>
            </div>
          ) : (
            <>
              <div className="bg-gradient-to-r from-green-500 to-emerald-600 rounded-2xl p-4 mb-4 text-white">
                <p className="text-xs font-bold opacity-80">{dateFilter ? "Earnings for selected date" : "Total Earnings Shown"}</p>
                <p className="text-2xl font-black mt-1">₹{Math.round(totalEarned)}</p>
                <p className="text-xs opacity-70 mt-0.5">₹{earningPerKm}/km × distance · {filtered.length} deliveries</p>
              </div>
              <div className="space-y-2">
                {filtered.map(o => <HistoryOrderRow key={o.id} order={o} earningPerKm={earningPerKm} />)}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Settings section ── */}
      {section === "profile" && (
        <div className="space-y-4">
          {/* Availability */}
          <div className="bg-white rounded-2xl border border-stone-100 p-4">
            <p className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-3">My Availability</p>
            <div className="flex gap-2">
              {["Available", "Busy", "Offline"].map(a => (
                <button key={a} onClick={() => {
                  if (a === "Offline" && !window.confirm("Go offline? You won't receive new deliveries.")) return;
                  onAvailChange(a);
                }}
                  className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${availability === a ? AVAIL_CFG[a].color + " text-white" : "bg-stone-100 text-stone-500"}`}>
                  {a}
                </button>
              ))}
            </div>
          </div>

          {/* Change password */}
          <div className="bg-white rounded-2xl border border-stone-100 p-4">
            <p className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-3">Change Password</p>
            <div className="space-y-2">
              <input type="password" value={oldPwd} onChange={e => setOldPwd(e.target.value)}
                placeholder="Current password"
                className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2.5 outline-none" />
              <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)}
                placeholder="New password (min 6 chars)"
                className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2.5 outline-none" />
              {pwdMsg && <p className={`text-xs ${pwdMsg.startsWith("✅") ? "text-green-600" : "text-red-500"}`}>{pwdMsg}</p>}
              <button onClick={changePwd} disabled={pwdLoading}
                className="w-full bg-stone-800 text-white font-bold py-3 rounded-xl text-sm disabled:opacity-50">
                {pwdLoading ? "Updating…" : "Update Password"}
              </button>
            </div>
          </div>

          {/* Logout */}
          <button onClick={onLogout}
            className="w-full flex items-center justify-center gap-2 border-2 border-red-200 text-red-500 font-bold py-4 rounded-2xl text-sm">
            <LogOut size={16} /> Logout
          </button>
          <div className="h-4" />
        </div>
      )}
    </div>
  );
}

// ── Login Screen ──────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [riderId, setRiderId] = useState("");
  const [pwd, setPwd]         = useState("");
  const [show, setShow]       = useState(false);
  const [err, setErr]         = useState("");
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const login = async () => {
    if (!riderId.trim() || !pwd) { setErr("Enter Rider ID and password."); return; }
    setLoading(true); setErr("");
    const { data, error } = await supabase.rpc("verify_rider_login", { p_rider_id: riderId.trim().toUpperCase(), p_password: pwd });
    setLoading(false);
    if (error || !data?.success) { setErr(data?.error || "Login failed."); return; }
    try { localStorage.setItem(LS_RIDER, JSON.stringify(data.rider)); } catch {}
    onLogin(data.rider);
  };

  return (
    <div className="bg-gradient-to-br from-stone-900 to-stone-800 flex items-center justify-center p-4 flex-1 w-full" style={{ minHeight: "-webkit-fill-available" }}>
      <div
        className="bg-white rounded-3xl p-8 w-full max-w-sm shadow-2xl"
        style={{
          transform: visible ? "translateY(0)" : "translateY(30px)",
          opacity: visible ? 1 : 0,
          transition: "transform 0.2s ease-out, opacity 0.2s ease-out",
        }}>
        <div className="text-center mb-7">
          <div className="w-20 h-20 bg-gradient-to-br from-orange-500 to-red-600 rounded-3xl flex items-center justify-center text-4xl mx-auto mb-3 shadow-lg">🛵</div>
          <h1 className="font-black text-stone-800 text-2xl">Rider Login</h1>
          <p className="text-xs text-stone-400 mt-1">Burger Point Delivery</p>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Rider ID</label>
            <input value={riderId} onChange={e => { setRiderId(e.target.value.toUpperCase()); setErr(""); }}
              onKeyDown={e => e.key === "Enter" && login()} placeholder="e.g. BP001"
              className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-2xl px-4 py-3.5 outline-none text-stone-700 font-mono tracking-wider" />
          </div>
          <div>
            <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Password</label>
            <div className="relative">
              <input type={show ? "text" : "password"} value={pwd}
                onChange={e => { setPwd(e.target.value); setErr(""); }}
                onKeyDown={e => e.key === "Enter" && login()} placeholder="••••••••"
                className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-2xl px-4 py-3.5 outline-none text-stone-700 pr-10" />
              <button onClick={() => setShow(s => !s)} aria-label="Toggle password visibility" className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400">
                {show ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>
        </div>
        {err && <p className="text-red-500 text-xs mt-3 text-center">{err}</p>}
        <button onClick={login} disabled={loading}
          className="w-full mt-5 bg-gradient-to-r from-orange-500 to-red-600 text-white py-4 rounded-2xl font-bold text-sm shadow-md active:scale-95 transition-transform disabled:opacity-60">
          {loading ? "Logging in…" : "🔑 Login"}
        </button>
        <button onClick={() => window.location.hash = ""}
          className="w-full mt-3 text-xs text-stone-400 underline">← Back to menu</button>
      </div>
    </div>
  );
}

// ── Main RiderApp ─────────────────────────────────────────
export default function RiderApp() {
  const { settings: bizSettings } = useBusinessSettings();
  const [rider,        setRider]        = useState(() => { try { return JSON.parse(localStorage.getItem(LS_RIDER)); } catch { return null; } });
  const [orders,       setOrders]       = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [tab,          setTab]          = useState("home");
  const [availability, setAvailability] = useState(rider?.availability || "Available");
  const [online,       setOnline]       = useState(true);
  const { popup, unread, acknowledge } = useRiderNotifications(rider?.rider_id, orders, !!rider);

  const login  = (r) => { setRider(r); setAvailability(r.availability); };
  const logout = () => { try { localStorage.removeItem(LS_RIDER); } catch {} setRider(null); setOrders([]); };

  // ── Validate stored session on mount ─────────────────────
  useEffect(() => {
    const stored = (() => { try { return JSON.parse(localStorage.getItem(LS_RIDER)); } catch { return null; } })();
    if (!stored?.rider_id || !SUPABASE_READY) return;
    // Silently verify the rider still exists in DB
    // IMPORTANT: only clear session if rider genuinely not found (PGRST116).
    // Network errors / timeouts must NOT wipe the session — causes blank screen on mobile.
    supabase.from("riders").select("rider_id, full_name, availability").eq("rider_id", stored.rider_id).single()
      .then(({ data, error }) => {
        if (data) {
          const updated = { ...stored, ...data };
          try { localStorage.setItem(LS_RIDER, JSON.stringify(updated)); } catch {}
          setRider(updated);
        } else if (error?.code === "PGRST116") {
          // Row genuinely doesn't exist — clear stale session
          try { localStorage.removeItem(LS_RIDER); } catch {}
          setRider(null);
        }
        // Any other error (network, timeout, RLS) — keep stored session as-is
      }).catch(() => { /* network error — keep session */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchOrders = useCallback(async () => {
    if (!rider || !SUPABASE_READY) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("rider_id", rider.rider_id)
      .order("created_at", { ascending: false });
    setLoading(false);
    if (!error && data) { setOrders(data.map(o => ({ ...o, items: Array.isArray(o.items) ? o.items : [] }))); setOnline(true); }
    else setOnline(false);
  }, [rider]);

  // Initial fetch + realtime subscription
  useEffect(() => {
    if (!rider) return;
    fetchOrders();
    const ch = supabase.channel(`rider_${rider.rider_id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, p => {
        if (p.new?.rider_id === rider.rider_id) fetchOrders();
      }).subscribe();
    return () => supabase.removeChannel(ch);
  }, [rider, fetchOrders]);

  // Update availability in DB
  const changeAvailability = async (avail) => {
    setAvailability(avail);
    await supabase.from("riders").update({ availability: avail, updated_at: new Date().toISOString() }).eq("rider_id", rider.rider_id);
    const updated = { ...rider, availability: avail };
    try { localStorage.setItem(LS_RIDER, JSON.stringify(updated)); } catch {}
    setRider(updated);
  };

  // Advance rider order status
  const advanceOrder = async (orderId) => {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;
    const transitions = { assigned: "accepted", accepted: "picked_up", picked_up: "delivered" };
    const next = transitions[order.rider_status];
    if (!next) return;

    const payload = { rider_status: next };
    if (next === "picked_up") {
      payload.picked_up_at = new Date().toISOString();
      payload.status = "dispatched"; // order status advances when rider physically picks up
    }
    if (next === "delivered") {
      payload.delivered_at = new Date().toISOString();
      payload.status = "served"; // update main order status
    }
    await supabase.from("orders").update(payload).eq("id", orderId);
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, ...payload } : o));
  };

  // Register push subscription for this rider
  useEffect(() => {
    if (!rider || !SUPABASE_READY || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
    (async () => {
      try {
        const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
        if (!vapidKey) return;
        const permission = await Notification.requestPermission();
        if (permission !== "granted") return;
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          const key = vapidKey.replace(/-/g, "+").replace(/_/g, "/");
          const raw = Uint8Array.from(atob(key), c => c.charCodeAt(0));
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
        }
        const subJson = sub.toJSON();
        await supabase.from("push_subscriptions").upsert({
          endpoint: subJson.endpoint,
          p256dh: subJson.keys?.p256dh,
          auth: subJson.keys?.auth,
          role: "rider",
          rider_id: rider.rider_id || null,
        }, { onConflict: "endpoint" });
      } catch (e) {
        // rider push subscription failed — non-critical
      }
    })();
  }, [rider]);
  const earningPerKm = Number(bizSettings?.earning_per_km ?? 10);

  if (!rider) return <LoginScreen onLogin={login} />;

  const tabs = [
    { id: "home",    icon: <Home size={18} />,      label: "Home" },
    { id: "account", icon: <User size={18} />,      label: "Account" },
  ];

  const availCfg = AVAIL_CFG[availability] || AVAIL_CFG.Available;

  return (
    <div className="bg-stone-50 flex flex-col max-w-lg mx-auto w-full" style={{ height: "100dvh" }}>
      {/* Top bar */}
      <div className="flex-shrink-0 bg-white border-b border-stone-100 shadow-sm">
        <div className="px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">🛵</span>
            <div>
              <p className="font-black text-stone-800 text-sm">{rider.full_name}</p>
              <div className="flex items-center gap-1.5">
                {online ? <Wifi size={9} className="text-green-500" /> : <WifiOff size={9} className="text-red-400" />}
                <span className={`text-[10px] font-bold ${online ? "text-green-600" : "text-red-500"}`}>
                  {online ? "Online" : "Offline"}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-bold text-white px-2.5 py-1 rounded-full ${availCfg.color}`}>
              {availability}
            </span>
            <button onClick={fetchOrders} disabled={loading}
              className="w-8 h-8 rounded-xl bg-stone-100 flex items-center justify-center">
              <RefreshCw size={13} className={`text-stone-500 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>
        {/* Tab bar */}
        <div className="flex border-t border-stone-100">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-bold transition-all relative ${tab === t.id ? "text-orange-500 border-b-2 border-orange-500" : "text-stone-400"}`}>
              {t.icon}
              {t.label}
              {t.id === "home" && unread > 0 && (
                <span className="absolute top-1 right-1/4 w-4 h-4 bg-red-500 text-white text-[9px] font-black rounded-full flex items-center justify-center">{unread}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Content — simple tab switch, no AnimatePresence (causes blank on mobile) */}
      <div className="flex-1 min-h-0 overflow-y-auto pb-6 overscroll-contain" style={{ WebkitOverflowScrolling: "touch" }}>
        {tab === "home"    && <HomeTab rider={rider} orders={orders} onAction={advanceOrder} onRefresh={fetchOrders} loading={loading} earningPerKm={earningPerKm} />}
        {tab === "account" && <AccountTab rider={rider} orders={orders} availability={availability} onAvailChange={changeAvailability} onLogout={logout} earningPerKm={earningPerKm} />}
      </div>

      {/* New order popup */}
      {popup && <NewOrderPopup order={popup} onAck={() => { acknowledge(); setTab("home"); }} />}
    </div>
  );
}

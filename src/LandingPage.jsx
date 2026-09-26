// ─────────────────────────────────────────────────────────
//  LandingPage.jsx — Burger Point entry screen
//
//  Split out of CustomerApp.jsx so this route (the one nearly every
//  first-time visitor hits) doesn't have to download and parse the
//  ~55 KB gzip Supabase SDK before it can paint. CustomerApp.jsx needs
//  Supabase eagerly for the live ordering flow; this page only needs it
//  for two background checks (business settings, busy-mode banner),
//  neither of which block the initial render, so the client is
//  dynamic-imported here instead of pulled in at module scope.
// ─────────────────────────────────────────────────────────
import { useState, useEffect, useRef } from "react";

// Inline SVGs replace the lucide-react import — LandingPage is intentionally
// kept dependency-free so it parses instantly on mobile. lucide-react is
// ~600 KB unparsed and was blocking first render on slow connections.
const X           = ({ size = 16 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
const ArrowLeft   = ({ size = 12 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>;
const Download    = ({ size = 15 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>;
const CalendarDays= ({ size = 15 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="14" x2="8" y2="14"/><line x1="12" y1="14" x2="12" y2="14"/><line x1="16" y1="14" x2="16" y2="14"/></svg>;

import { SUPABASE_READY, REVIEW_URL, WHATSAPP, INSTAGRAM } from "./constants.js";
import { useBusinessSettings } from "./useBusinessSettings.js";

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

export function LandingPage({ installPrompt }) {
  const [mode,          setMode]          = useState(null);
  const [showUpdateGate, setShowUpdateGate] = useState(false);
  const [code,          setCode]          = useState("");
  const [err,           setErr]           = useState("");
  const [shake,         setShake]         = useState(false);
  const [iosHint,       setIosHint]       = useState(false);
  const [busy,          setBusy]          = useState(null);
  const inputRef = useRef(null);
  const isIos        = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia("(display-mode:standalone)").matches;
  const { settings: bizSettings } = useBusinessSettings();
  const updateAvailable = useAppUpdateAvailable();

  const handleOrderTypePick = (id) => {
    if (updateAvailable) { setShowUpdateGate(true); return; }
    if (id === "takeaway") window.location.hash = "takeaway";
    else if (id === "delivery") window.location.hash = "delivery";
    else setMode("dine");
  };

  // Check busy/closed mode — Supabase client is dynamic-imported so it
  // isn't part of this route's initial bundle.
  useEffect(() => {
    if (!SUPABASE_READY) return;
    let alive = true;
    import("./supabase.js").then(({ supabase }) => {
      if (!alive) return;
      supabase.from("busy_mode").select("*").eq("id", 1).single()
        .then(({ data }) => { if (alive && data?.is_busy) setBusy(data); });
    });
    return () => { alive = false; };
  }, []);

  const go = (c) => {
    const tbl = {
      "7294831056": "Table 1", "4058379126": "Table 2", "8163059247": "Table 3",
      "2947063815": "Table 4", "5820394176": "Table 5", "3614729058": "Table 6",
      "9037246815": "Table 7", "1472958630": "Table 8", "6895230174": "Table 9",
      "4260817953": "Table 10", "8531064279": "Table 11", "3749158260": "Table 12",
      "7048263591": "Table 13", "3619470825": "Table 14", "5283701964": "Table 15",
      "9146852037": "Table 16", "2705638149": "Table 17", "6493027581": "Table 18",
      "8027541693": "Table 19", "1359820746": "Table 20",
    };
    if (!tbl[c.trim()]) {
      setErr("Invalid table code. Please check again.");
      setShake(true); setTimeout(() => setShake(false), 600); return;
    }
    window.location.hash = `table=${c.trim()}`;
  };

  const handleInstall = () => { if (isIos) { setIosHint(true); return; } installPrompt?.prompt(); };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-orange-50 via-amber-50 to-yellow-50 p-4">

      {/* Busy/Closed banner */}
      {busy && (
        <div className="w-full max-w-sm mb-4 bg-red-50 border-2 border-red-200 rounded-2xl p-4 text-center">
          <p className="text-lg mb-1">🔴</p>
          <p className="font-bold text-red-700 text-sm">We're Currently Closed</p>
          <p className="text-xs text-red-600 mt-1">{busy.message || "Please check back later."}</p>
          {busy.opens_at && <p className="text-xs text-red-500 font-bold mt-1">Opens at {busy.opens_at}</p>}
        </div>
      )}

      <div className="text-center mb-7">
        <div className="w-24 h-24 bg-gradient-to-br from-orange-500 to-red-600 rounded-3xl shadow-2xl flex items-center justify-center mx-auto mb-4 text-5xl overflow-hidden">
          {bizSettings.logo_url
            ? <img src={bizSettings.logo_url} alt={bizSettings.restaurant_name} className="w-full h-full object-cover" onError={(e) => { e.target.style.display = "none"; e.target.parentElement.textContent = "🍔"; }} />
            : "🍔"}
        </div>
        <h1 className="text-4xl font-black text-stone-800 tracking-tight">{bizSettings.restaurant_name || "Burger Point"}</h1>
        <p className="text-stone-500 mt-1 text-sm">{bizSettings.address || "Jankipuram, Lucknow"}</p>
        <div className="flex items-center justify-center gap-1 mt-1.5">
          <span className="w-3.5 h-3.5 border-2 border-green-600 rounded-sm bg-white flex items-center justify-center flex-shrink-0">
            <span className="w-2 h-2 rounded-full bg-green-600" />
          </span>
          <span className="text-[11px] text-green-700 font-bold">100% Pure Vegetarian</span>
        </div>
      </div>

      {/* Order type blocks — direct 3-tile layout, no modal */}
      {!mode && !busy && (
        <div className="w-full max-w-sm space-y-3">
          <div className="grid grid-cols-3 gap-3">
            {[
              { id: "dine",     icon: "🍽️", label: "Dine-In",   sub: "Table order" },
              { id: "takeaway", icon: "📦", label: "Takeaway",  sub: "Pick up" },
              { id: "delivery", icon: "🛵", label: "Delivery",  sub: "To your door" },
            ].map(m => (
              <button key={m.id} onClick={() => handleOrderTypePick(m.id)}
                className="bg-white border-2 border-orange-100 hover:border-orange-400 active:border-orange-500 rounded-3xl py-5 px-2 flex flex-col items-center gap-1.5 shadow-sm hover:shadow-md transition-all active:scale-95">
                <span className="text-4xl">{m.icon}</span>
                <span className="text-xs font-black text-stone-800">{m.label}</span>
                <span className="text-[10px] text-stone-400 text-center leading-tight">{m.sub}</span>
              </button>
            ))}
          </div>
          <button onClick={() => window.location.hash = "reservation"}
            className="w-full flex items-center justify-center gap-2 bg-white border-2 border-stone-100 text-stone-600 text-sm font-bold py-3 rounded-2xl hover:border-orange-300 hover:text-orange-600 transition-all">
            <CalendarDays size={15} /> Book a Table
          </button>
        </div>
      )}

      {mode === "dine" && (
        <div className={`bg-white rounded-3xl shadow-xl border border-orange-100 p-6 w-full max-w-sm ${shake ? "animate-pulse" : ""}`}>
          <button onClick={() => { setMode(null); setCode(""); setErr(""); }} className="text-xs text-stone-400 flex items-center gap-1 mb-4">
            <ArrowLeft size={12} /> Back
          </button>
          <h2 className="font-bold text-stone-700 text-base mb-1 text-center">Enter Table Code</h2>
          <p className="text-xs text-stone-400 text-center mb-5">10-digit code on your table card</p>
          <div className="relative mb-3">
            <input ref={inputRef} value={code}
              onChange={e => { setCode(e.target.value.replace(/\D/g, "").slice(0, 10)); setErr(""); }}
              onKeyDown={e => e.key === "Enter" && go(code)}
              placeholder="_ _ _ _ _ _ _ _ _ _" inputMode="numeric"
              className="w-full text-center text-2xl font-black tracking-widest border-2 border-orange-200 focus:border-orange-500 rounded-2xl px-4 py-4 outline-none text-stone-800 transition-colors placeholder:text-stone-200" />
            {code && <button onClick={() => { setCode(""); setErr(""); inputRef.current?.focus(); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-300"><X size={16} /></button>}
          </div>
          {err && <p className="text-red-500 text-xs text-center mb-3 font-medium">{err}</p>}
          <div className="grid grid-cols-3 gap-2 mb-4">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, "←", 0, "Go"].map((k, i) => (
              <button key={i} onClick={() => {
                if (k === "←") { setCode(c => c.slice(0, -1)); setErr(""); }
                else if (k === "Go") go(code);
                else if (code.length < 10) { setCode(c => c + k); setErr(""); }
              }} className={`py-3.5 rounded-2xl font-bold text-base transition-all active:scale-95 ${k === "Go" ? "bg-gradient-to-br from-orange-500 to-red-500 text-white shadow-md" : k === "←" ? "bg-stone-100 text-stone-500" : "bg-orange-50 text-stone-700 hover:bg-orange-100"}`}>
                {k}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-stone-300 text-center">Ask staff for your table code</p>
        </div>
      )}

      {!isStandalone && (installPrompt || isIos) && (
        <div className="mt-4 w-full max-w-sm">
          <button onClick={handleInstall}
            className="w-full flex items-center justify-center gap-2 bg-white border border-orange-200 text-orange-700 text-sm font-bold py-3 rounded-2xl shadow-sm hover:shadow-md transition-all">
            <Download size={15} /> Add to Home Screen
          </button>
          {iosHint && (
            <div className="mt-2 bg-orange-50 border border-orange-200 rounded-2xl p-3 text-xs text-orange-800 text-center">
              Tap <strong>Share ↗</strong> → <strong>"Add to Home Screen"</strong> in Safari
            </div>
          )}
        </div>
      )}

      <div className="mt-5 flex gap-2 flex-wrap justify-center">
        {[
          { icon: "⭐", label: "Review Us", href: REVIEW_URL, ext: true },
          { icon: "📸", label: "Instagram", href: INSTAGRAM, ext: true },
          { icon: "💬", label: "WhatsApp", href: WHATSAPP, ext: true },
        ].map(l => (
          <a key={l.label} href={l.href} target="_blank" rel="noreferrer"
            className="flex items-center gap-1.5 bg-white/80 border border-white text-stone-600 text-xs font-medium px-3 py-2 rounded-2xl shadow-sm hover:shadow-md transition-all">
            {l.icon} {l.label}
          </a>
        ))}
        <button onClick={() => window.location.hash = "privacy"} className="flex items-center gap-1.5 bg-white/80 border border-white text-stone-600 text-xs font-medium px-3 py-2 rounded-2xl shadow-sm hover:shadow-md transition-all">🛡️ Privacy</button>
        <button onClick={() => window.location.hash = "contact"} className="flex items-center gap-1.5 bg-white/80 border border-white text-stone-600 text-xs font-medium px-3 py-2 rounded-2xl shadow-sm hover:shadow-md transition-all">📞 Contact</button>
      </div>
      <div className="flex items-center gap-3 mt-4">
        <p className="text-xs text-white font-semibold">Admin? <button onClick={() => window.location.hash = "admin"} className="bg-orange-500 text-white font-bold px-3 py-1 rounded-lg ml-1 shadow">Login here</button></p>
        <span className="text-stone-200 text-[10px]">·</span>
        <p className="text-xs text-white font-semibold">Rider? <button onClick={() => window.location.hash = "rider"} className="bg-stone-700 text-white font-bold px-3 py-1 rounded-lg ml-1 shadow">Login here</button></p>
      </div>

      {/* ── Update Gate (landing) ── */}
      {showUpdateGate && (
        <div className="fixed inset-0 bg-black/60 z-[70] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-6 max-w-xs w-full text-center shadow-2xl">
            <div className="w-16 h-16 rounded-full bg-orange-100 flex items-center justify-center text-3xl mx-auto mb-3">🔄</div>
            <p className="font-black text-stone-800 text-lg">Update Required</p>
            <p className="text-sm text-stone-500 mt-2">A newer version of Burger Point is available. Please update first to place your order — it only takes a second!</p>
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

export default LandingPage;
import { useState, useEffect, lazy, Suspense } from "react";
import { getRoute } from "./constants.js";
import { ErrorBoundary } from "./ErrorBoundary.jsx";

// ── Lazy-load all heavy page bundles ──────────────────────────────────────────
// Nothing is downloaded until the user navigates to that route.
// AdminApp (247 KB) and RiderApp (40 KB) are NEVER fetched on the customer path.
// CustomerApp.jsx (228 KB) is deferred too — the inline HTML splash in index.html
// keeps the screen populated while it downloads, so users never see a blank screen.
//
// Vite/Rollup deduplicates multiple import('./CustomerApp.jsx') calls at runtime
// — the file is only downloaded once regardless of which named export is used first.

const AdminApp        = lazy(() => import('./AdminApp.jsx'));
const RiderApp        = lazy(() => import('./RiderApp.jsx'));

// LandingPage lives in its own file (not CustomerApp.jsx) specifically so
// this route — the one nearly every first-time visitor hits — doesn't
// have to download the Supabase SDK bundled into CustomerApp's chunk
// before it can render. See LandingPage.jsx for details.
const LandingPage     = lazy(() => import('./LandingPage.jsx'));
const CustomerApp     = lazy(() => import('./CustomerApp.jsx').then(m => ({ default: m.CustomerApp })));
const PrivacyPage     = lazy(() => import('./CustomerApp.jsx').then(m => ({ default: m.PrivacyPage })));
const ContactPage     = lazy(() => import('./CustomerApp.jsx').then(m => ({ default: m.ContactPage })));
const ReservationPage = lazy(() => import('./CustomerApp.jsx').then(m => ({ default: m.ReservationPage })));

// ── Suspense fallbacks ────────────────────────────────────────────────────────
// Landing splash matches the inline HTML in index.html exactly so there's no
// visual jump when React takes over from the static HTML.
function LandingSplash() {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", minHeight: "100svh", padding: "1rem",
      background: "linear-gradient(135deg,#fff8f0 0%,#fef3c7 50%,#fefce8 100%)",
    }}>
      <div style={{
        width: "6rem", height: "6rem", borderRadius: "1.5rem",
        background: "linear-gradient(135deg,#f97316,#dc2626)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "3rem", marginBottom: "1rem",
        boxShadow: "0 20px 60px rgba(249,115,22,0.35)",
      }}>🍔</div>
      <h1 style={{ fontSize: "2.25rem", fontWeight: 900, color: "#1c1917", letterSpacing: "-0.02em", lineHeight: 1.1 }}>
        Burger Point
      </h1>
      <p style={{ color: "#78716c", fontSize: "0.875rem", marginTop: "0.375rem" }}>
        Jankipuram, Lucknow
      </p>
    </div>
  );
}

// Minimal spinner for admin/rider routes (user navigated there intentionally)
function PageSpinner() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100svh", background: "#fff8f0" }}>
      <div style={{ display: "flex", gap: "6px" }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{
            width: 10, height: 10, borderRadius: "50%", background: "#f97316",
            animation: "bounce 0.6s ease-in-out infinite",
            animationDelay: `${i * 0.15}s`,
          }} />
        ))}
      </div>
      <style>{`@keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}`}</style>
    </div>
  );
}

// ── Reset confirmation screen ─────────────────────────────────────────────────
// Shown briefly after #reset-order clears a stuck order, then redirects.
function ResetOrderPage() {
  useEffect(() => {
    const t = setTimeout(() => {
      window.location.replace(window.location.pathname + window.location.search);
    }, 2000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-orange-50 gap-4 p-6 text-center">
      <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center text-3xl">✅</div>
      <p className="font-black text-stone-800 text-lg">Screen cleared!</p>
      <p className="text-sm text-stone-500">Taking you back to the menu…</p>
      <div className="flex gap-1.5">
        {[0, 1, 2].map(i => (
          <div key={i} className="w-2 h-2 rounded-full bg-orange-400 animate-bounce"
            style={{ animationDelay: `${i * 0.15}s` }} />
        ))}
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [route,          setRoute]          = useState(getRoute);
  const [installPrompt,  setInstallPrompt]  = useState(null);

  useEffect(() => {
    const onHash          = () => setRoute(getRoute());
    const onBeforeInstall = (e) => { e.preventDefault(); setInstallPrompt(e); };
    window.addEventListener("hashchange",        onHash);
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    return () => {
      window.removeEventListener("hashchange",        onHash);
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
    };
  }, []);

  const { page, code, label } = route;

  // Pick the right fallback: landing-style splash for default route,
  // simple spinner for everything else (user chose to go there).
  const isLanding  = page === "landing" || !page;
  const fallback   = isLanding ? <LandingSplash /> : <PageSpinner />;

  const content = (() => {
    if (page === "admin")       return <AdminApp />;
    if (page === "rider")       return <RiderApp />;
    if (page === "privacy")     return <PrivacyPage />;
    if (page === "contact")     return <ContactPage />;
    if (page === "reservation") return <ReservationPage />;
    if (page === "takeaway")    return <CustomerApp orderType="takeaway" />;
    if (page === "delivery")    return <CustomerApp orderType="delivery" />;
    if (page === "customer")    return <CustomerApp code={code} tableLabel={label} orderType="dine-in" />;
    if (page === "reset-order") return <ResetOrderPage />;
    return <LandingPage installPrompt={installPrompt} />;
  })();

  // Admin app has no ErrorBoundary — the boundary was causing a constant
  // "Something went wrong" screen on mobile whenever a new order arrived.
  // Other routes keep the boundary as a safety net.
  if (page === "admin") {
    return (
      <Suspense fallback={fallback}>
        {content}
      </Suspense>
    );
  }

  const boundaryLabel = page === "rider" ? "Rider app" : "This page";

  return (
    <ErrorBoundary label={boundaryLabel}>
      <Suspense fallback={fallback}>
        {content}
      </Suspense>
    </ErrorBoundary>
  );
}

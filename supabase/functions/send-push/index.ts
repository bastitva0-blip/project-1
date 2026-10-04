import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as webpush from "https://esm.sh/web-push@3.6.7";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-webhook-secret",
};
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUB      = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIV     = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_MAILTO   = Deno.env.get("VAPID_SUBJECT") ?? Deno.env.get("VAPID_MAILTO") ?? "mailto:admin@burgerpoint.co.in";
// Shared secret so ONLY your database webhook / cron can trigger owner alerts.
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
webpush.setVapidDetails(VAPID_MAILTO, VAPID_PUB, VAPID_PRIV);

type Sub = { endpoint: string; p256dh: string; auth: string };

async function sendOne(sub: Sub, payload: string, urgent = false): Promise<boolean> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload,
      // urgency "high" + TTL: wakes the phone immediately, even in Doze mode.
      { urgency: urgent ? "high" : "normal", TTL: urgent ? 600 : 3600 },
    );
    return true;
  } catch (e: any) {
    if (e?.statusCode === 410 || e?.statusCode === 404) {
      await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    } else {
      console.error("sendOne failed:", e?.statusCode, e?.body);
    }
    return false;
  }
}

async function getSubs(role?: string): Promise<Sub[]> {
  let q = supabase.from("push_subscriptions").select("endpoint, p256dh, auth");
  if (role) q = q.eq("role", role);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function blast(subs: Sub[], payload: object, urgent = false) {
  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(subs.map(s => sendOne(s, body, urgent)));
  const sent = results.filter(r => r.status === "fulfilled" && (r as PromiseFulfilledResult<boolean>).value).length;
  return { sent, total: subs.length };
}

const res = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });

const itemCount = (items: any) =>
  Array.isArray(items) ? items.reduce((n, i) => n + (Number(i?.qty) || 1), 0) : 0;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json();
    const trusted = !!WEBHOOK_SECRET && req.headers.get("x-webhook-secret") === WEBHOOK_SECRET;

    // ── 1. New order → alert the owner (Supabase Database Webhook on orders INSERT) ──
    if (body?.type === "INSERT" && body?.table === "orders") {
      if (!trusted) return res({ error: "unauthorized" }, 401);
      const o = body.record ?? {};
      if (o.status && o.status !== "pending") return res({ skipped: "not pending" });

      const who   = o.table_label || o.customer_name || "Customer";
      const kind  = String(o.order_type || "order").replace(/^\w/, (c: string) => c.toUpperCase());
      const n     = itemCount(o.items);
      const subs  = await getSubs("admin");
      const out   = await blast(subs, {
        title: `🔔 NEW ORDER — ₹${o.total ?? ""}`,
        body:  `${who} · ${kind}${n ? ` · ${n} item${n > 1 ? "s" : ""}` : ""}`,
        icon:  "/icon-192.png",
        url:   "/#admin",
        tag:   `order-${o.id}`,
        kind:  "admin-order",
      }, true);
      return res(out);
    }

    // ── 2. Reminder → still-unaccepted orders (called every minute by pg_cron) ──
    if (body?.mode === "reminder") {
      if (!trusted) return res({ error: "unauthorized" }, 401);
      const since = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
      const { data: pend } = await supabase
        .from("orders").select("id, created_at")
        .eq("status", "pending").gte("created_at", since);
      const waiting = (pend ?? []).filter(o => Date.now() - new Date(o.created_at).getTime() > 90_000);
      if (!waiting.length) return res({ sent: 0, message: "nothing waiting" });
      const out = await blast(await getSubs("admin"), {
        title: `⏰ ${waiting.length} order${waiting.length > 1 ? "s" : ""} waiting — ACCEPT NOW`,
        body:  "Customers are waiting. Open the admin panel and accept.",
        icon:  "/icon-192.png",
        url:   "/#admin",
        tag:   "orders-waiting",
        kind:  "admin-order",
      }, true);
      return res(out);
    }

    // ── 3. Manual broadcast from Admin → Settings → Push Notifications ──
    const { title, message, audience = "all", url = "/" } =
      body as { title: string; message: string; audience?: string; url?: string };

    if (!title || !message) return res({ error: "title and message required" }, 400);
    if (audience === "admin" && !trusted) return res({ error: "unauthorized" }, 401);

    let role: string | undefined;
    if (audience === "customers") role = "customer";
    else if (audience === "riders") role = "rider";
    else if (audience === "admin") role = "admin";

    let subs: Sub[];
    if (role) subs = await getSubs(role);
    else {
      // "all" = customers + riders only; never spam the owner's phone with promos.
      const { data, error } = await supabase.from("push_subscriptions")
        .select("endpoint, p256dh, auth").neq("role", "admin");
      if (error) return res({ error: error.message }, 500);
      subs = data ?? [];
    }
    if (!subs.length) return res({ sent: 0, message: "No subscribers" });

    return res(await blast(subs, { title, body: message, icon: "/icon-192.png", url }));
  } catch (e) {
    return res({ error: String(e) }, 500);
  }
});

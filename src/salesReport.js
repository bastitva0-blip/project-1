// ─────────────────────────────────────────────────────────
//  salesReport.js — 30-day sales report (.xlsx) for the Sales tab
//
//  exceljs is dynamic-imported only when the owner taps Download, so it
//  adds nothing to the admin bundle's first load.
//
//  Definitions (also printed at the bottom of the Summary sheet):
//   • Revenue figures exclude cancelled orders.
//   • Net Revenue   = sum of order totals (what the customer paid).
//   • Gross Revenue = Net Revenue + discounts (before coupons).
//   • Delivered     = status "served" or "completed".
//   • Days / hours use the device's local time (IST on the shop's phone).
// ─────────────────────────────────────────────────────────

export const REPORT_DAYS = 30;

const ORANGE = "FFE65C00", PEACH = "FFFFF3EC", GREY = "FFF2F2F2", INK = "FF1A1A1A", ZEBRA = "FFFFF8F5";
const FONT = "Arial";
const RUPEE = '"₹"#,##0', RUPEE2 = '"₹"#,##0.00', PCT = "0.0%", INT = "#,##0", DEC1 = "0.0";
const thin = { style: "thin", color: { argb: "FFDDDDDD" } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const pad = n => String(n).padStart(2, "0");
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayLabel = d => `${pad(d.getDate())} ${MON[d.getMonth()]}`;
const longDate = d => `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`;
const num = x => Number(x) || 0;
const TYPE_LABEL = { "dine-in": "Dine-In", takeaway: "Takeaway", delivery: "Delivery" };

export function reportStart(now = new Date()) {
  const s = new Date(now);
  s.setDate(s.getDate() - (REPORT_DAYS - 1));
  s.setHours(0, 0, 0, 0);
  return s;
}

// ── Data ─────────────────────────────────────────────────
// Supabase returns at most 1000 rows per request, so page through.
export async function fetchReportOrders(supabase, now = new Date()) {
  const since = reportStart(now).toISOString();
  const cols = "id,created_at,status,order_type,total,discount,promo_code,payment_method,customer_name,customer_phone,items";
  const PAGE = 1000;
  let from = 0;
  const all = [];
  for (;;) {
    const { data, error } = await supabase.from("orders").select(cols)
      .gte("created_at", since)
      .order("created_at", { ascending: true }).order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

function itemsOf(o) { return Array.isArray(o.items) ? o.items : []; }
function basketSize(o) { return itemsOf(o).reduce((s, i) => s + (Number(i.qty) || 1), 0); }

// ── Sheet helpers ────────────────────────────────────────
function setup(ws, widths) {
  ws.views = [{ showGridLines: false }];
  ws.columns = widths.map(w => ({ width: w }));
  ws.pageSetup = { orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}
function style(cell, o = {}) {
  cell.font = { name: FONT, size: o.size || 10, bold: !!o.bold, color: { argb: o.color || "FF000000" } };
  if (o.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: o.fill } };
  cell.alignment = { horizontal: o.align || "center", vertical: "middle", wrapText: !!o.wrap };
  if (o.border !== false) cell.border = BORDER;
  if (o.fmt) cell.numFmt = o.fmt;
}
function banner(ws, row, text, cols, o = {}) {
  ws.mergeCells(row, 1, row, cols);
  const c = ws.getCell(row, 1);
  c.value = text;
  style(c, { size: o.size || 16, bold: true, color: "FFFFFFFF", fill: ORANGE, border: false, align: o.align || "center" });
  ws.getRow(row).height = o.height || 36;
}
function sub(ws, row, text, cols) {
  ws.mergeCells(row, 1, row, cols);
  const c = ws.getCell(row, 1);
  c.value = text;
  style(c, { size: 11, color: "FF555555", fill: PEACH, border: false });
  ws.getRow(row).height = 22;
}
function section(ws, row, text, cols) {
  banner(ws, row, "  " + text, cols, { size: 12, align: "left", height: 26 });
}
function head(ws, row, labels) {
  labels.forEach((l, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = l;
    style(c, { size: 11, bold: true, color: INK, fill: GREY, wrap: true });
  });
  ws.getRow(row).height = 24;
}
// vals: plain values or { f: "SUM(B2:B3)", r: result }
function line(ws, row, vals, o = {}) {
  vals.forEach((v, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = v && typeof v === "object" && "f" in v ? { formula: v.f, result: v.r } : v;
    style(c, {
      bold: o.bold || (o.boldFirst && i === 0),
      color: o.total ? "FFFFFFFF" : "FF000000",
      fill: o.total ? INK : (o.zebra ? ZEBRA : "FFFFFFFF"),
      align: i === 0 && o.leftFirst ? "left" : "center",
      fmt: o.fmts?.[i],
    });
  });
}
function note(ws, row, text, cols) {
  ws.mergeCells(row, 1, row, cols);
  const c = ws.getCell(row, 1);
  c.value = text;
  c.font = { name: FONT, size: 9, italic: true, color: { argb: "FF777777" } };
  c.alignment = { horizontal: "left", vertical: "top", wrapText: true };
}

// ── Aggregation ──────────────────────────────────────────
export function buildReportData(orders, now = new Date()) {
  const start = reportStart(now);
  const inWin = orders.filter(o => { const t = new Date(o.created_at); return t >= start && t <= now; });
  const live = inWin.filter(o => o.status !== "cancelled");
  const cancelled = inWin.length - live.length;
  const delivered = live.filter(o => o.status === "served" || o.status === "completed").length;
  const inProgress = live.length - delivered;
  const net = live.reduce((s, o) => s + num(o.total), 0);
  const disc = live.reduce((s, o) => s + num(o.discount), 0);

  // month
  const monthMap = new Map();
  live.forEach(o => {
    const d = new Date(o.created_at), k = d.getFullYear() * 100 + d.getMonth();
    const m = monthMap.get(k) || { label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, orders: 0, gross: 0, net: 0 };
    m.orders++; m.net += num(o.total); m.gross += num(o.total) + num(o.discount);
    monthMap.set(k, m);
  });
  const months = [...monthMap.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);

  // payment
  const payMap = new Map();
  live.forEach(o => {
    const k = (o.payment_method || "Cash").trim() || "Cash";
    const p = payMap.get(k) || { method: k, orders: 0, rev: 0 };
    p.orders++; p.rev += num(o.total); payMap.set(k, p);
  });
  const payments = [...payMap.values()].sort((a, b) => b.orders - a.orders);

  // order types
  const typeMap = new Map();
  live.forEach(o => {
    const k = o.order_type || "dine-in";
    const t = typeMap.get(k) || { type: TYPE_LABEL[k] || k, orders: 0, rev: 0 };
    t.orders++; t.rev += num(o.total); typeMap.set(k, t);
  });
  const types = [...typeMap.values()].sort((a, b) => b.orders - a.orders);

  // basket
  const sizes = live.filter(o => itemsOf(o).length > 0).map(basketSize);
  const basket = {
    avg: sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0,
    min: sizes.length ? Math.min(...sizes) : 0,
    max: sizes.length ? Math.max(...sizes) : 0,
    total: sizes.reduce((a, b) => a + b, 0),
  };

  // coupons
  const cMap = new Map();
  const withC = live.filter(o => o.promo_code && String(o.promo_code).trim());
  withC.forEach(o => {
    const k = String(o.promo_code).trim().toUpperCase();
    const c = cMap.get(k) || { code: k, uses: 0, disc: 0, rev: 0 };
    c.uses++; c.disc += num(o.discount); c.rev += num(o.total); cMap.set(k, c);
  });
  const coupons = [...cMap.values()].sort((a, b) => b.uses - a.uses || b.disc - a.disc);
  const withoutC = live.filter(o => !(o.promo_code && String(o.promo_code).trim()));
  const sumTotal = arr => arr.reduce((s, o) => s + num(o.total), 0);
  const sumDisc = arr => arr.reduce((s, o) => s + num(o.discount), 0);
  const impact = {
    withN: withC.length, withRev: sumTotal(withC), withDisc: sumDisc(withC),
    withoutN: withoutC.length, withoutRev: sumTotal(withoutC),
  };

  // bestsellers
  const itemMap = new Map();
  live.forEach(o => itemsOf(o).forEach(i => {
    const name = (i.name || "Unknown item").trim();
    const q = Number(i.qty) || 1;
    const it = itemMap.get(name) || { name, qty: 0, rev: 0 };
    it.qty += q; it.rev += q * num(i.finalPrice); itemMap.set(name, it);
  }));
  const bestsellers = [...itemMap.values()].sort((a, b) => b.qty - a.qty || b.rev - a.rev).slice(0, 10);

  // daily (every one of the 30 days, zeros included)
  const daily = [];
  const dMap = new Map();
  for (let i = 0; i < REPORT_DAYS; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const row = { key: dayKey(d), label: dayLabel(d), orders: 0, rev: 0 };
    daily.push(row); dMap.set(row.key, row);
  }
  live.forEach(o => { const r = dMap.get(dayKey(new Date(o.created_at))); if (r) { r.orders++; r.rev += num(o.total); } });

  // hours
  const hMap = new Map();
  live.forEach(o => {
    const h = new Date(o.created_at).getHours();
    const x = hMap.get(h) || { h, orders: 0, rev: 0 };
    x.orders++; x.rev += num(o.total); hMap.set(h, x);
  });
  const hours = [...hMap.values()].sort((a, b) => b.orders - a.orders || a.h - b.h);

  // customers (phone preferred, else name; anonymous dine-in orders are skipped)
  const custMap = new Map();
  let anon = 0;
  live.forEach(o => {
    const phone = String(o.customer_phone || "").replace(/\D/g, "").slice(-10);
    const name = (o.customer_name || "").trim();
    const key = phone || name.toLowerCase();
    if (!key) { anon++; return; }
    const c = custMap.get(key) || { name: "", phone, orders: 0, spent: 0, last: null };
    if (name) c.name = name;
    c.orders++; c.spent += num(o.total);
    const t = new Date(o.created_at);
    if (!c.last || t > c.last) c.last = t;
    custMap.set(key, c);
  });
  const customers = [...custMap.values()].sort((a, b) => b.spent - a.spent || b.orders - a.orders).slice(0, 10);

  return { start, now, total: inWin.length, live: live.length, cancelled, delivered, inProgress, net, disc, gross: net + disc,
    months, payments, types, basket, coupons, impact, bestsellers, daily, hours, customers, anon };
}

// ── Workbook ─────────────────────────────────────────────
export function buildWorkbook(ExcelJS, orders, now = new Date()) {
  const R = buildReportData(orders, now);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Burger Point";
  wb.created = now;
  const period = `Period: ${longDate(R.start)} – ${longDate(now)}  (last ${REPORT_DAYS} days)`;

  // ===== Summary
  const ws = wb.addWorksheet("Summary");
  const C = 5;
  setup(ws, [30, 18, 22, 22, 20]);
  banner(ws, 1, "🍔  BURGER POINT — SALES REPORT", C);
  sub(ws, 2, period, C);
  let r = 4;

  section(ws, r++, "📊  Overview", C);
  head(ws, r++, ["Metric", "Value"]);
  const ov = r;
  const rows = [
    ["Total Orders", R.total, INT],
    ["Gross Revenue", R.gross, RUPEE],
    ["Total Discounts", R.disc, RUPEE],
    ["Net Revenue", { f: `B${ov + 1}-B${ov + 2}`, r: R.net }, RUPEE],
    ["Avg Order Value", { f: `IFERROR(B${ov + 3}/(B${ov}-B${ov + 6}),0)`, r: R.live ? R.net / R.live : 0 }, RUPEE2],
    ["Delivered Orders", R.delivered, INT],
    ["Cancelled Orders", R.cancelled, INT],
  ];
  if (R.inProgress > 0) rows.push(["In Progress (not closed yet)", R.inProgress, INT]);
  rows.forEach((x, i) => line(ws, r++, [x[0], x[1]], { zebra: i % 2 === 1, boldFirst: true, leftFirst: true, fmts: [null, x[2]] }));
  r++;

  section(ws, r++, "📅  Monthly Breakdown", C);
  head(ws, r++, ["Month", "Orders", "Gross Revenue (₹)", "Net Revenue (₹)"]);
  const m0 = r;
  R.months.forEach((m, i) => line(ws, r++, [m.label, m.orders, m.gross, m.net], { zebra: i % 2 === 1, fmts: [null, INT, RUPEE, RUPEE] }));
  if (!R.months.length) line(ws, r++, ["No orders in this period", "", "", ""], {});
  const mLast = r - 1;
  line(ws, r++, ["TOTAL",
    { f: `SUM(B${m0}:B${mLast})`, r: R.live }, { f: `SUM(C${m0}:C${mLast})`, r: R.gross }, { f: `SUM(D${m0}:D${mLast})`, r: R.net }],
    { total: true, fmts: [null, INT, RUPEE, RUPEE] });
  r++;

  section(ws, r++, "💳  Payment Methods", C);
  head(ws, r++, ["Method", "Orders", "Revenue (₹)", "% Share"]);
  const p0 = r, pEnd = p0 + R.payments.length - 1, pTot = pEnd + 1;
  R.payments.forEach((p, i) => line(ws, r++, [p.method, p.orders, p.rev, { f: `IFERROR(C${p0 + i}/C$${pTot},0)`, r: R.net ? p.rev / R.net : 0 }],
    { zebra: i % 2 === 1, fmts: [null, INT, RUPEE, PCT] }));
  if (!R.payments.length) { line(ws, r++, ["No orders in this period", "", "", ""], {}); }
  line(ws, r++, ["TOTAL", { f: `SUM(B${p0}:B${pEnd})`, r: R.live }, { f: `SUM(C${p0}:C${pEnd})`, r: R.net }, ""], { total: true, fmts: [null, INT, RUPEE] });
  r++;

  section(ws, r++, "🛵  Order Types", C);
  head(ws, r++, ["Type", "Orders", "Revenue (₹)", "% of Orders", "Avg Order (₹)"]);
  const t0 = r, tEnd = t0 + R.types.length - 1, tTot = tEnd + 1;
  R.types.forEach((t, i) => line(ws, r++, [t.type, t.orders, t.rev,
    { f: `IFERROR(B${t0 + i}/B$${tTot},0)`, r: R.live ? t.orders / R.live : 0 },
    { f: `IFERROR(C${t0 + i}/B${t0 + i},0)`, r: t.orders ? t.rev / t.orders : 0 }],
    { zebra: i % 2 === 1, fmts: [null, INT, RUPEE, PCT, RUPEE2] }));
  if (!R.types.length) line(ws, r++, ["No orders in this period", "", "", "", ""], {});
  line(ws, r++, ["TOTAL", { f: `SUM(B${t0}:B${tEnd})`, r: R.live }, { f: `SUM(C${t0}:C${tEnd})`, r: R.net }, "", ""], { total: true, fmts: [null, INT, RUPEE] });
  r++;

  section(ws, r++, "🧺  Basket Size", C);
  head(ws, r++, ["Metric", "Value"]);
  [["Avg Items per Order", R.basket.avg, DEC1], ["Min Items in an Order", R.basket.min, INT],
   ["Max Items in an Order", R.basket.max, INT], ["Total Items Sold", R.basket.total, INT]]
    .forEach((x, i) => line(ws, r++, [x[0], x[1]], { zebra: i % 2 === 1, boldFirst: true, leftFirst: true, fmts: [null, x[2]] }));
  r++;

  section(ws, r++, "🏷️  Coupon Usage", C);
  head(ws, r++, ["Coupon Code", "Times Used", "Discount Given (₹)", "Revenue from Orders (₹)"]);
  if (R.coupons.length) {
    const c0 = r;
    R.coupons.forEach((c, i) => line(ws, r++, [c.code, c.uses, c.disc, c.rev], { zebra: i % 2 === 1, fmts: [null, INT, RUPEE, RUPEE] }));
    const cLast = r - 1;
    line(ws, r++, ["TOTAL", { f: `SUM(B${c0}:B${cLast})`, r: R.impact.withN }, { f: `SUM(C${c0}:C${cLast})`, r: R.impact.withDisc }, { f: `SUM(D${c0}:D${cLast})`, r: R.impact.withRev }],
      { total: true, fmts: [null, INT, RUPEE, RUPEE] });
  } else line(ws, r++, ["No coupons used in this period", "", "", ""], {});
  r++;

  section(ws, r++, "📉  Coupon Impact", C);
  head(ws, r++, ["Segment", "Orders", "Net Revenue (₹)", "Avg Order Value (₹)", "% of Orders"]);
  const i0 = r;
  const I = R.impact;
  line(ws, r++, ["With coupon", I.withN, I.withRev, { f: `IFERROR(C${i0}/B${i0},0)`, r: I.withN ? I.withRev / I.withN : 0 }, { f: `IFERROR(B${i0}/(B${i0}+B${i0 + 1}),0)`, r: R.live ? I.withN / R.live : 0 }],
    { boldFirst: true, leftFirst: true, fmts: [null, INT, RUPEE, RUPEE2, PCT] });
  line(ws, r++, ["Without coupon", I.withoutN, I.withoutRev, { f: `IFERROR(C${i0 + 1}/B${i0 + 1},0)`, r: I.withoutN ? I.withoutRev / I.withoutN : 0 }, { f: `IFERROR(B${i0 + 1}/(B${i0}+B${i0 + 1}),0)`, r: R.live ? I.withoutN / R.live : 0 }],
    { zebra: true, boldFirst: true, leftFirst: true, fmts: [null, INT, RUPEE, RUPEE2, PCT] });
  line(ws, r++, ["Discount % of gross (coupon orders)", { f: `IFERROR(${I.withDisc}/(C${i0}+${I.withDisc}),0)`, r: (I.withRev + I.withDisc) ? I.withDisc / (I.withRev + I.withDisc) : 0 }, "", "", ""],
    { boldFirst: true, leftFirst: true, fmts: [null, PCT] });
  line(ws, r++, ["Avg discount per coupon order", { f: `IFERROR(${I.withDisc}/B${i0},0)`, r: I.withN ? I.withDisc / I.withN : 0 }, "", "", ""],
    { zebra: true, boldFirst: true, leftFirst: true, fmts: [null, RUPEE2] });
  r++;

  note(ws, r, "Notes: Revenue figures exclude cancelled orders. Net Revenue = amount customers paid (after coupons). Gross Revenue = Net + discounts. " +
    "Delivered = served or completed orders. Times are in the device's local time.", C);
  ws.getRow(r).height = 40;

  // ===== Bestsellers
  const bs = wb.addWorksheet("Bestsellers");
  setup(bs, [6, 34, 14, 18, 20]);
  banner(bs, 1, `🏆  TOP 10 BESTSELLERS — last ${REPORT_DAYS} days`, 5);
  head(bs, 3, ["#", "Item", "Qty Sold", "Revenue (₹)", "Note"]);
  R.bestsellers.forEach((b, i) => line(bs, 4 + i, [i + 1, b.name, b.qty, b.rev, i === 0 ? "⭐ #1 Bestseller" : ""], { zebra: i % 2 === 1, fmts: [null, null, INT, RUPEE] }));
  if (!R.bestsellers.length) line(bs, 4, ["", "No items sold in this period", "", "", ""], {});
  bs.views = [{ showGridLines: false, state: "frozen", ySplit: 3 }];

  // ===== Daily Sales
  const ds = wb.addWorksheet("Daily Sales");
  setup(ds, [16, 14, 18, 18]);
  banner(ds, 1, `📈  DAILY SALES — last ${REPORT_DAYS} days`, 4);
  head(ds, 3, ["Date", "Orders", "Revenue (₹)", "Avg per Order (₹)"]);
  R.daily.forEach((d, i) => {
    const rr = 4 + i;
    line(ds, rr, [d.label, d.orders, d.rev, { f: `IFERROR(C${rr}/B${rr},0)`, r: d.orders ? d.rev / d.orders : 0 }], { zebra: i % 2 === 1, fmts: [null, INT, RUPEE, RUPEE2] });
  });
  const dEnd = 3 + R.daily.length, dTot = dEnd + 1;
  line(ds, dTot, ["TOTAL", { f: `SUM(B4:B${dEnd})`, r: R.live }, { f: `SUM(C4:C${dEnd})`, r: R.net }, { f: `IFERROR(C${dTot}/B${dTot},0)`, r: R.live ? R.net / R.live : 0 }],
    { total: true, fmts: [null, INT, RUPEE, RUPEE2] });
  ds.views = [{ showGridLines: false, state: "frozen", ySplit: 3 }];

  // ===== Peak Hours
  const ph = wb.addWorksheet("Peak Hours");
  setup(ph, [20, 14, 18, 18]);
  banner(ph, 1, "⏰  PEAK HOURS", 4);
  head(ph, 3, ["Time Slot", "Orders", "Revenue (₹)", "Note"]);
  R.hours.forEach((h, i) => line(ph, 4 + i, [`${pad(h.h)}:00 – ${pad((h.h + 1) % 24)}:00`, h.orders, h.rev, i < 3 ? "🔥 Peak" : ""], { zebra: i % 2 === 1, fmts: [null, INT, RUPEE] }));
  if (!R.hours.length) line(ph, 4, ["No orders in this period", "", "", ""], {});
  ph.views = [{ showGridLines: false, state: "frozen", ySplit: 3 }];

  // ===== Top Customers
  const tc = wb.addWorksheet("Top Customers");
  setup(tc, [6, 26, 16, 10, 16, 16, 16]);
  banner(tc, 1, `👑  TOP CUSTOMERS — last ${REPORT_DAYS} days`, 7);
  head(tc, 3, ["#", "Customer", "Phone", "Orders", "Total Spent (₹)", "Avg Order (₹)", "Last Order"]);
  R.customers.forEach((c, i) => {
    const rr = 4 + i;
    line(tc, rr, [i + 1, c.name || "(no name)", c.phone || "—", c.orders, c.spent, { f: `IFERROR(E${rr}/D${rr},0)`, r: c.orders ? c.spent / c.orders : 0 }, c.last ? longDate(c.last) : ""],
      { zebra: i % 2 === 1, fmts: [null, null, null, INT, RUPEE, RUPEE2] });
  });
  if (!R.customers.length) line(tc, 4, ["", "No customers with a phone or name in this period", "", "", "", "", ""], {});
  if (R.anon > 0) note(tc, 5 + Math.max(R.customers.length, 1), `${R.anon} order(s) had no customer name or phone (typically dine-in) and are not listed.`, 7);
  tc.views = [{ showGridLines: false, state: "frozen", ySplit: 3 }];

  return { wb, R };
}

// ── Browser entry point ──────────────────────────────────
export async function downloadSalesReport(supabase) {
  const now = new Date();
  const [{ default: ExcelJS }, orders] = await Promise.all([import("exceljs"), fetchReportOrders(supabase, now)]);
  const { wb, R } = buildWorkbook(ExcelJS, orders, now);
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `BurgerPoint_Sales_Report_${dayKey(R.start)}_to_${dayKey(now)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return { orders: R.total };
}

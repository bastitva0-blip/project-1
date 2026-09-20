import { useState, useEffect, useCallback, useRef } from "react";
import QRCode from "qrcode";
import { useToast, OrderCardSkeleton, SalesSkeleton, CustomerRowSkeleton, RiderCardSkeleton } from "./ui.jsx";
import {
  Plus, Trash2, Edit2, Edit3, X, LogOut, RefreshCw,
  CheckCircle, Users, BarChart2, Settings, ShoppingBag,
  Wifi, WifiOff, ArrowLeft, Phone, Lock, Eye, EyeOff,
  Bike, Tag, CalendarDays, Clock, ToggleLeft, ToggleRight,
  Send, Bell,
  Image, ChevronDown, ChevronUp, Save, Printer,
  Search, LayoutGrid, XCircle,
} from "lucide-react";
import { supabase } from "./supabase.js";
import { SUPABASE_READY, STATUS_CFG, getNextStep, CATEGORIES, DEFAULT_MENU, ALL_ITEMS, TABLE_CODES,
  CANCEL_REASONS, ACTIVE_STATUSES, isOrderActive, isOrderTerminal,
} from "./constants.js";
import { useBusinessSettings } from "./useBusinessSettings.js";

// ─────────────────────────────────────────────────────────
//  RIDER GROUP CONFIG
//  Replace this with your actual WhatsApp group invite link.
//  e.g. "https://chat.whatsapp.com/AbCdEfGhIjK"
// ─────────────────────────────────────────────────────────
const RIDER_GROUP_LINK = "https://chat.whatsapp.com/DYiZE1enhbE2oklsgwdvUf";

function buildPickupMessage(order, earningPerKm = 10) {
  const orderId = String(order.id ?? "").slice(-6).toUpperCase() || "------";
  const address = order.delivery_address || "No address provided";
  const total   = Number(order.total || 0).toLocaleString("en-IN");
  const payment = (order.payment_method || "PENDING").toUpperCase();
  const isPaid  = payment !== "PENDING" && payment !== "CASH";
  const payTag  = isPaid ? "PAID" : payment;

  // Prefer OSRM road distance (route_distance_km, set on rider assign),
  // fall back to straight-line haversine distance (delivery_distance_km, set on order place).
  const km      = Number(order.route_distance_km || order.delivery_distance_km || 0);
  const payout  = km > 0 ? Math.round(km * earningPerKm) : null;
  const payoutLine = payout !== null
    ? `\n💵 Payout: ₹${payout} (${km}km × ₹${earningPerKm}/km)`
    : `\n💵 Payout: TBD (distance not yet calculated)`;

  const itemLines = (order.items || [])
    .map(it => {
      const variant = it.selectedVariant ? ` (${it.selectedVariant})` : "";
      return `  • ${it.name}${variant} ×${it.qty}`;
    })
    .join("\n");

  const mapsLink =
    order.customer_lat && order.customer_lng
      ? `\n🗺️ https://maps.google.com/?q=${order.customer_lat},${order.customer_lng}`
      : "";

  const note = order.note ? `\n📝 Note: ${order.note}` : "";

  return (
    `🛵 *Delivery Request*\n` +
    `Order #${orderId}\n` +
    `📍 ${address}${mapsLink}\n` +
    `💰 Rs.${total} (${payTag})` +
    payoutLine + `\n` +
    `📦 Items:\n${itemLines}` +
    note
  );
}

// ─────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────
const normalise = row => {
  let time;
  try {
    time = new Date(row.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  } catch {
    time = new Date(row.created_at).toTimeString().slice(0, 5);
  }
  return { ...row, time, items: Array.isArray(row.items) ? row.items : [] };
};

const currency = n => {
  try { return `₹${Number(n || 0).toLocaleString("en-IN")}`; }
  catch { return `₹${Number(n || 0).toFixed(0)}`; }
};

// ─────────────────────────────────────────────────────────
//  ESC/POS THERMAL PRINTER  (WebUSB — 80 mm roll, ~42 chars)
// ─────────────────────────────────────────────────────────

/* ESC/POS byte constants */
const ESC = 0x1B;
const GS  = 0x1D;
const LF  = 0x0A;

const P_INIT        = [ESC, 0x40];          // Reset / initialize
const P_CUT         = [GS,  0x56, 0x42, 0x05]; // Partial cut + 5-line feed
const P_LEFT        = [ESC, 0x61, 0x00];    // Left align
const P_CENTER      = [ESC, 0x61, 0x01];    // Center align
const P_BOLD_ON     = [ESC, 0x45, 0x01];    // Bold on
const P_BOLD_OFF    = [ESC, 0x45, 0x00];    // Bold off
const P_DOUBLE_ON   = [ESC, 0x21, 0x30];    // 2× height + 2× width
const P_DOUBLE_OFF  = [ESC, 0x21, 0x00];    // Normal font size
const P_FEED        = [ESC, 0x64, 0x03];    // Feed 3 lines

const PW = 42; // characters per line on an 80 mm roll

/* Text layout helpers */
const pLine   = (t, w = PW) => { const s = String(t ?? ""); return s.length >= w ? s.slice(0, w) : s.padEnd(w, " "); };
const pCenter = (t, w = PW) => { const s = String(t ?? ""); if (s.length >= w) return s.slice(0, w); return " ".repeat(Math.floor((w - s.length) / 2)) + s; };
const pRow    = (l, r, w = PW) => { const ls = String(l ?? ""), rs = String(r ?? ""); const gap = w - ls.length - rs.length; return gap <= 0 ? (ls + " " + rs).slice(0, w) : ls + " ".repeat(gap) + rs; };
const pDiv    = (c = "-", w = PW) => c.repeat(w);

/* Convert a string to UTF-8 bytes (handles ₹ via code-page override below) */
function strToBytes(text) {
  // Replace ₹ with "Rs." since most budget thermal printers lack Unicode ₹
  const safe = text.replace(/₹/g, "Rs.");
  return Array.from(new TextEncoder().encode(safe));
}

/* Build final Uint8Array from a mix of byte-arrays and strings */
function buildEscPos(cmds) {
  const bytes = [];
  for (const cmd of cmds) {
    if (Array.isArray(cmd))       bytes.push(...cmd);
    else if (typeof cmd === "string") bytes.push(...strToBytes(cmd), LF);
  }
  return new Uint8Array(bytes);
}

/* ── Module-level USB state (survives React re-renders) ── */
let _usbDev = null;
let _usbEp  = null;

export async function connectUsbPrinter() {
  const dev = await navigator.usb.requestDevice({ filters: [{ classCode: 0x07 }] });
  await dev.open();
  if (dev.configuration === null) await dev.selectConfiguration(1);
  let found = false;
  for (let i = 0; i < (dev.configuration?.interfaces?.length ?? 0); i++) {
    try {
      await dev.claimInterface(i);
      const alt = dev.configuration.interfaces[i].alternates[0];
      for (const ep of alt.endpoints) {
        if (ep.direction === "out" && ep.type === "bulk") { _usbEp = ep.endpointNumber; found = true; break; }
      }
      if (found) break;
    } catch { /* try next interface */ }
  }
  if (!found) throw new Error("No bulk-OUT endpoint found on this printer.");
  _usbDev = dev;
  return dev.productName || "USB Printer";
}

export async function sendToPrinter(buffer) {
  if (!_usbDev) throw new Error("Printer not connected.");
  const CHUNK = 16384;
  for (let off = 0; off < buffer.length; off += CHUNK) {
    await _usbDev.transferOut(_usbEp, buffer.slice(off, off + CHUNK));
  }
}

/* ── KOT (Kitchen Order Ticket) layout ── */
export function buildKOT(order) {
  const now  = new Date();
  const ds   = now.toLocaleDateString("en-IN");
  const ts   = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  const who  = order.table_label || order.customer_name || ("Order #" + (String(order.id ?? "").slice(-4)));
  const type = (order.order_type || "dine-in").toUpperCase();
  const bill = String(order.id ?? "").slice(-6).toUpperCase() || "------";

  const cmds = [
    P_INIT,
    P_CENTER, P_BOLD_ON, P_DOUBLE_ON, "BURGER POINT", P_DOUBLE_OFF,
    P_CENTER, "** KITCHEN ORDER TICKET **", P_BOLD_OFF,
    P_LEFT, pDiv("="),
    pRow("Date: " + ds, "Time: " + ts),
    pRow("Bill: " + bill,        "Type: " + type),
    "For : " + who,
    pDiv("="),
    P_BOLD_ON, pRow(pLine("ITEM", PW - 6), "  QTY"), P_BOLD_OFF,
    pDiv("-"),
  ];

  for (const it of (order.items || [])) {
    const name = it.name + (it.selectedVariant ? ` (${it.selectedVariant})` : "");
    const qty  = String(it.qty || 1);
    if (name.length > PW - qty.length - 3) {
      cmds.push(name.slice(0, PW));
      cmds.push(pRow("", qty));
    } else {
      cmds.push(pRow(name, qty));
    }
    if (it.addonLabels?.length) it.addonLabels.forEach(a => cmds.push("  + " + a));
  }

  cmds.push(pDiv("-"));
  if (order.note) { cmds.push(P_BOLD_ON, "NOTE: " + order.note, P_BOLD_OFF, pDiv("-")); }
  cmds.push(P_CENTER, "-- KOT Printed --", "", P_FEED, P_CUT);
  return buildEscPos(cmds);
}

/* ── Customer Invoice layout ── */
export function buildInvoice(order, settings = {}) {
  const rName  = settings.restaurant_name || "Burger Point";
  const rAddr  = settings.address         || "60 Feet Road, Jankipuram, Lucknow";
  const rPhone = settings.phone           || "+91 9194008822";
  const gstNo  = settings.gst_number      || "09ACOFA177BK1ZS";
  const gstPct = Number(settings.gst_percent ?? 0);

  const now     = new Date();
  const ds      = now.toLocaleDateString("en-IN");
  const ts      = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  const billNo  = String(order.id ?? "").slice(-6).toUpperCase() || "------";

  const items     = order.items || [];
  const subTotal  = items.reduce((s, it) => s + Number(it.finalPrice || it.price || 0) * Number(it.qty || 1), 0);
  const discount  = Number(order.discount || 0);
  const delivery  = Number(order.delivery_fee ?? 0);
  const packing   = order.order_type === "dine-in" ? 0 : Number(order.packing_charge ?? order.packingCharge ?? settings.packing_charge ?? 0);
  const gstAmt    = gstPct > 0 ? Math.round((subTotal - discount) * gstPct / 100) : 0;
  const grandTotal = Number(order.total || (subTotal - discount + delivery + packing + gstAmt));
  const cur       = (n) => "Rs." + Number(n || 0).toFixed(2);

  const cmds = [
    P_INIT,
    P_CENTER, P_BOLD_ON, P_DOUBLE_ON, rName, P_DOUBLE_OFF,
    pCenter(rAddr),
    pCenter("Ph: " + rPhone),
    pCenter("GSTIN: " + gstNo),
    P_BOLD_OFF, P_LEFT, pDiv("="),
    P_BOLD_ON, pCenter("CUSTOMER INVOICE"), P_BOLD_OFF,
    pDiv("="),
  ];

  // Order meta block
  const meta = [
    ["Bill No ", billNo],
    ["Date    ", ds + "  " + ts],
    ["Type    ", (order.order_type || "dine-in").toUpperCase()],
  ];
  if (order.platform || order.source) meta.unshift(["Platform", order.platform || order.source]);
  if (order.table_label)    meta.push(["Table   ", order.table_label]);
  if (order.customer_name)  meta.push(["Customer", order.customer_name]);
  if (order.customer_phone) meta.push(["Phone   ", order.customer_phone]);
  if (order.payment_method) meta.push(["Payment ", order.payment_method.toUpperCase()]);
  meta.forEach(([k, v]) => cmds.push(pRow(k + ":", v)));

  // Items table header
  cmds.push(pDiv("-"));
  const COL = { name: 22, qty: 5, price: 7, amt: 7 }; // name+qty+price+amt = 41 + spaces
  cmds.push(
    P_BOLD_ON,
    pLine("ITEM", COL.name).padEnd(COL.name) + " " +
    "QTY".padStart(COL.qty) + " " +
    "RATE".padStart(COL.price) + " " +
    "AMT".padStart(COL.amt),
    P_BOLD_OFF,
    pDiv("-"),
  );

  for (const it of items) {
    const addonPrices = (it.addonLabels || []).map(l => { const m = l.match(/\+₹(\d+)/); return { label: l, price: m ? Number(m[1]) : 0 }; });
    const addonSum2   = addonPrices.reduce((s, a) => s + a.price, 0);
    const baseRate2   = Number(it.finalPrice || it.price || 0) - addonSum2;
    const qty2        = Number(it.qty || 1);
    const name  = (it.name + (it.selectedVariant ? ` (${it.selectedVariant})` : "")).slice(0, COL.name);
    const qty   = String(qty2).padStart(COL.qty);
    const rate  = ("Rs." + baseRate2.toFixed(0)).padStart(COL.price);
    const amt   = ("Rs." + (baseRate2 * qty2).toFixed(0)).padStart(COL.amt);
    cmds.push(name.padEnd(COL.name) + " " + qty + " " + rate + " " + amt);
    addonPrices.forEach(a => {
      const aLabel = ("  + " + a.label.replace(/\s*\+₹\d+/, "")).slice(0, COL.name);
      const aRate  = (a.price > 0 ? "Rs." + a.price : "-").padStart(COL.price);
      const aAmt   = (a.price > 0 ? "Rs." + (a.price * qty2).toFixed(0) : "-").padStart(COL.amt);
      cmds.push(aLabel.padEnd(COL.name) + " " + qty + " " + aRate + " " + aAmt);
    });
  }

  // Totals
  cmds.push(pDiv("-"));
  cmds.push(pRow("Sub Total", cur(subTotal)));
  if (discount > 0)   cmds.push(pRow("Discount Fixed", "-" + cur(discount)));
  if (delivery > 0)   cmds.push(pRow("Delivery Charge", cur(delivery)));
  if (packing > 0)    cmds.push(pRow("Packaging Charge", cur(packing)));
  if (gstAmt > 0)     cmds.push(pRow(`GST (${gstPct}%)`, cur(gstAmt)));
  if (order.promo_code) cmds.push(pRow("Promo: " + order.promo_code, "Applied"));

  cmds.push(pDiv("="));
  cmds.push(P_BOLD_ON, pRow("GRAND TOTAL", cur(grandTotal)), P_BOLD_OFF);
  cmds.push(pDiv("="));

  // Footer
  cmds.push(
    P_CENTER,
    "Tax to be paid under section 9(5) by Eco",
    "",
    P_BOLD_ON, "*** Thanks, Visit Again! ***", P_BOLD_OFF,
    "Follow us @burgerpoint_as",
    "", "", P_FEED, P_CUT,
  );

  return buildEscPos(cmds);
}

/* ── HTML Window Print (80 mm thermal) ── */
const THERMAL_CSS = `
  @page { size: 80mm auto; margin: 1mm 2mm; }
  * { box-sizing: border-box; margin: 0; padding: 0;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important; }
  body {
    font-family: 'Courier New', Courier, monospace;
    font-size: 14px;
    font-weight: 800;
    line-height: 1.35;
    width: 76mm;
    color: #000;
    background: #fff;
    text-shadow: 0 0 0.7px #000, 0 0 0.4px #000;
    -webkit-text-stroke: 0.2px #000;
  }
  .brand {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 20px; font-weight: 900;
    text-align: center; letter-spacing: 0.5px;
    text-shadow: 0 0 1.5px #000, 0 0 0.8px #000;
  }
  .subinfo { font-size: 12px; text-align: center; font-weight: 700; line-height: 1.3; }
  .section-head {
    font-size: 14px; font-weight: 900; text-align: center;
    text-shadow: 0 0 1px #000;
    margin: 2px 0 1px;
  }
  .div-eq   { border-top: 3px solid #000; margin: 3px 0; }
  .div-2eq  { border-top: 3px double #000; margin: 3px 0; }
  .div-dash { border-top: 2px dashed #000; margin: 3px 0; }
  table { width: 100%; border-collapse: collapse; }
  td    { vertical-align: top; padding: 2px 0; font-size: 14px; font-weight: 800; }
  td.lbl { width: 50%; }
  td.val { text-align: right; }
  td.bold-lbl { font-weight: 900; font-size: 14px; }
  .items-head td { font-size: 14px; font-weight: 900;
                   border-bottom: 2px dashed #000; padding-bottom: 2px; }
  .item-row td  { padding: 2px 0; }
  .addon  { font-size: 12px; font-weight: 700; padding-left: 6px; }
  .totals td { font-size: 14px; padding: 2px 0; }
  .grand-row td {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 19px; font-weight: 900;
    padding: 4px 0;
    text-shadow: 0 0 1.5px #000, 0 0 0.8px #000;
    -webkit-text-stroke: 0.3px #000;
  }
  .paid-badge {
    display: flex; justify-content: space-between;
    font-size: 13px; font-weight: 900;
    margin-bottom: 2px;
  }
  .footer {
    text-align: center; font-size: 13px; font-weight: 800;
    margin-top: 1px; line-height: 1.3;
  }
  .thanks {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 16px; font-weight: 900;
    text-align: center; margin-top: 2px;
    text-shadow: 0 0 1px #000;
  }
`;

function buildReceiptHTML(order, settings = {}, isKOT = false) {
  const rName  = settings.restaurant_name || "Burger Point";
  const rAddr  = settings.address         || "60 Feet Road, Jankipuram, Lucknow";
  const rPhone = settings.phone           || "+91 9194008822";
  const gstNo  = settings.gst_number      || "09ACOFA177BK1ZS";
  const gstPct = Number(settings.gst_percent ?? 0);

  const now  = new Date();
  const ds   = now.toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" });
  const ts   = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  const billNo = String(order.id ?? "").slice(-6).toUpperCase() || "------";

  const items     = order.items || [];
  const totalQty  = items.reduce((s, it) => s + Number(it.qty || 1), 0);
  const subTotal  = items.reduce((s, it) => s + Number(it.finalPrice || it.price || 0) * Number(it.qty || 1), 0);
  const discount  = Number(order.discount || 0);
  const delivery  = Number(order.delivery_fee ?? 0);
  const packing   = order.order_type === "dine-in" ? 0 : Number(order.packing_charge ?? order.packingCharge ?? settings.packing_charge ?? 0);
  const taxable   = subTotal - discount;
  const gstAmt    = gstPct > 0 ? Math.round(taxable * gstPct / 100) : 0;
  const grandTotal = Number(order.total || (taxable + delivery + packing + gstAmt));
  const cur = (n) => "Rs." + Number(n || 0).toFixed(0);

  // ── KOT ─────────────────────────────────────────────────
  if (isKOT) {
    const kotNo = String(order.id ?? "").slice(-4).toUpperCase();
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
    <title>KOT</title><style>${THERMAL_CSS}</style></head><body>
    <div class="brand">${rName}</div>
    <div class="section-head">** KITCHEN ORDER **</div>
    <div class="div-eq"></div>
    <table>
      <tr><td class="lbl">KOT No</td><td class="val bold-lbl">${kotNo}</td></tr>
      <tr><td class="lbl">Time</td><td class="val">${ts}</td></tr>
      <tr><td class="lbl">Date</td><td class="val">${ds}</td></tr>
      <tr><td class="lbl">Type</td><td class="val">${(order.order_type||"dine-in").toUpperCase()}</td></tr>
      ${order.table_label ? `<tr><td class="lbl bold-lbl">Table</td><td class="val bold-lbl">${order.table_label}</td></tr>` : ""}
    </table>
    <div class="div-dash"></div>
    <table>
      <tr class="items-head">
        <td>ITEM</td>
        <td align="right">QTY</td>
      </tr>
      ${items.map(it => `
        <tr class="item-row">
          <td>${it.name}${it.selectedVariant ? ` (${it.selectedVariant})` : ""}</td>
          <td align="right" style="font-size:18px;font-weight:900;">${it.qty || 1}</td>
        </tr>
        ${(it.addonLabels || []).map(a => `<tr><td class="addon" colspan="2">+ ${a}</td></tr>`).join("")}
      `).join("")}
    </table>
    ${order.note ? `<div class="div-dash"></div><div style="font-size:14px;"><b>Note:</b> ${order.note}</div>` : ""}
    <div class="div-eq"></div>
    <div class="footer">-- KOT Printed --</div>
    </body></html>`;
  }

  // ── INVOICE ──────────────────────────────────────────────
  const isPaid = order.payment_method && order.payment_method.toLowerCase() !== "pending";
  const payLabel = (order.payment_method || "").toUpperCase();
  const orderType = (order.order_type || "dine-in").replace(/-/g," ").replace(/\b\w/g,c=>c.toUpperCase());
  const orderSource = order.platform || order.source || "";

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
  <title>Invoice</title><style>${THERMAL_CSS}</style></head><body>

  ${isPaid ? `<div class="paid-badge"><span>✓ PAID</span><span>PAID ✓</span></div>` : ""}

  <div class="brand">${rName}</div>
  <div class="subinfo">
    ${rAddr}<br/>
    Mob: ${rPhone}<br/>
    GSTIN: ${gstNo}
  </div>

  <div class="div-dash"></div>
  <table>
    ${orderSource ? `<tr><td class="lbl">Order Source</td><td class="val">${orderSource}</td></tr>` : ""}
    <tr><td class="lbl">Order ID</td><td class="val">#${billNo}</td></tr>
    ${order.customer_name  ? `<tr><td class="lbl">Customer</td><td class="val">${order.customer_name}</td></tr>` : ""}
    ${order.customer_phone ? `<tr><td class="lbl">Phone</td><td class="val">${order.customer_phone}</td></tr>` : ""}
  </table>

  <div class="div-dash"></div>
  <table>
    <tr><td class="lbl">Date</td><td class="val">${ds}</td></tr>
    <tr><td class="lbl">Time</td><td class="val">${ts}</td></tr>
    <tr><td class="lbl">Order Type</td><td class="val">${orderType}</td></tr>
    ${order.table_label ? `<tr><td class="lbl">Table</td><td class="val">${order.table_label}</td></tr>` : ""}
    <tr><td class="lbl bold-lbl">Bill No</td><td class="val bold-lbl">${billNo}</td></tr>
  </table>

  <div class="div-dash"></div>
  <table>
    <tr class="items-head">
      <td style="width:42%">Item</td>
      <td align="center" style="width:10%">Qty</td>
      <td align="right" style="width:20%">Rate</td>
      <td align="right" style="width:28%">Amt</td>
    </tr>
    ${items.map(it => {
      const qty  = Number(it.qty || 1);
      // Parse addon prices out of labels like "Cold Coffee +₹99"
      // Base price = finalPrice minus sum of all addon prices
      const addonPriceMap = (it.addonLabels || []).map(label => {
        const m = label.match(/\+₹(\d+)/);
        return { label, price: m ? Number(m[1]) : 0 };
      });
      const addonSum = addonPriceMap.reduce((s, a) => s + a.price, 0);
      const baseRate = Number(it.finalPrice || it.price || 0) - addonSum;
      return `
      <tr class="item-row">
        <td>${it.name}${it.selectedVariant ? `<br/><span style="font-size:12px">(${it.selectedVariant})</span>` : ""}</td>
        <td align="center">${qty}</td>
        <td align="right">Rs.${baseRate.toFixed(0)}</td>
        <td align="right">Rs.${(baseRate*qty).toFixed(0)}</td>
      </tr>
      ${addonPriceMap.map(a => `
      <tr style="font-size:12px;color:#000;">
        <td style="padding-left:10px;">+ ${a.label.replace(/\s*\+₹\d+/, "")}</td>
        <td align="center">${qty}</td>
        <td align="right">${a.price > 0 ? `Rs.${a.price}` : "-"}</td>
        <td align="right">${a.price > 0 ? `Rs.${(a.price*qty).toFixed(0)}` : "-"}</td>
      </tr>`).join("")}`;
    }).join("")}
  </table>

  <div class="div-dash"></div>
  <table class="totals">
    <tr><td class="lbl">Total Qty</td><td class="val">${totalQty}</td></tr>
    <tr><td class="lbl">Subtotal</td><td class="val">${cur(subTotal)}</td></tr>
    ${discount > 0 ? `<tr><td class="lbl">Discount${order.promo_code ? ` (${order.promo_code})` : ""}</td><td class="val">-${cur(discount)}</td></tr>` : ""}
    ${delivery > 0 ? `<tr><td class="lbl">Delivery Charge</td><td class="val">${cur(delivery)}</td></tr>` : ""}
    ${packing  > 0 ? `<tr><td class="lbl">Packaging</td><td class="val">${cur(packing)}</td></tr>` : ""}
    ${gstAmt   > 0 ? `
      <tr><td class="lbl">CGST (${(gstPct/2).toFixed(1)}%)</td><td class="val">${cur(gstAmt/2)}</td></tr>
      <tr><td class="lbl">SGST (${(gstPct/2).toFixed(1)}%)</td><td class="val">${cur(gstAmt/2)}</td></tr>
    ` : ""}
  </table>

  <div class="div-2eq"></div>
  <table><tr class="grand-row">
    <td>GRAND TOTAL:</td>
    <td align="right">Rs.${grandTotal.toFixed(0)}</td>
  </tr></table>
  <div class="div-2eq"></div>

  <table class="totals" style="margin-top:4px">
    ${payLabel ? `<tr><td class="lbl">Payment</td><td class="val">${payLabel}</td></tr>` : ""}
    <tr><td class="lbl" style="font-size:12px;color:#555">Tax under Sec 9(5)</td><td></td></tr>
  </table>

  <div class="div-dash" style="margin-top:4px"></div>
  <div style="page-break-inside:avoid; text-align:center; margin: 4px 0 0;">
    <img id="bp-qr" width="100" height="100" style="display:block; margin:0 auto;" alt="QR" />
    <div style="font-size:12px; font-weight:800; margin-top:2px; margin-bottom:3px;">Scan to reorder anytime!</div>
    <div class="div-dash"></div>
    <div class="thanks">Thanks for visiting!</div>
    <div class="footer">Follow us @burgerpoint_lko</div>
  </div>

  </body></html>`;
}

const QR_URL = "https://burgerpoint.co.in/";

async function openPrintWindow(html) {
  // Generate QR code offline as a data URL
  let qrDataUrl = "";
  try {
    qrDataUrl = await QRCode.toDataURL(QR_URL, {
      width: 100,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    });
  } catch (e) {
    // QR generation failed — non-critical
  }

  const w = window.open("", "_blank", "width=420,height=800");
  if (!w) { toast.error("Pop-up blocked! Please allow pop-ups for this site, then try again."); return; }
  w.document.write(html);
  w.document.close();

  // Inject the offline QR data URL into the img tag
  if (qrDataUrl) {
    const img = w.document.getElementById("bp-qr");
    if (img) img.src = qrDataUrl;
  }

  w.focus();
  setTimeout(() => { w.print(); w.close(); }, 400);
}

export async function printInvoice(order, settings) {
  await openPrintWindow(buildReceiptHTML(order, settings, false));
}

export async function printKOT(order) {
  await openPrintWindow(buildReceiptHTML(order, {}, true));
}

// ─────────────────────────────────────────────────────────
//  ADMIN LOGIN SCREEN
// ─────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState("");
  const [pwd, setPwd]         = useState("");
  const [show, setShow]       = useState(false);
  const [err, setErr]         = useState("");
  const [loading, setLoading] = useState(false);

  const login = async () => {
    if (!email.trim() || !pwd.trim()) { setErr("Enter email and password."); return; }
    if (!SUPABASE_READY) { setErr("Supabase not configured."); return; }
    setLoading(true); setErr("");
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: pwd });
      if (error) { setErr(error.message || "Login failed. Check your credentials."); }
      else onLogin();
    } catch (e) {
      setErr("Something went wrong. Please try again.");
    }
    setLoading(false);
  };

  return (
    <div className="bg-gradient-to-br from-stone-900 to-stone-800 flex items-center justify-center p-4" style={{minHeight:"100dvh"}}>
      <div className="bg-white rounded-3xl p-8 w-full max-w-sm shadow-2xl">
        <div className="text-center mb-7">
          <div className="w-16 h-16 bg-gradient-to-br from-orange-500 to-red-600 rounded-2xl flex items-center justify-center text-3xl mx-auto mb-3">🍔</div>
          <h1 className="font-black text-stone-800 text-2xl">Admin Login</h1>
          <p className="text-xs text-stone-400 mt-1">Burger Point Dashboard</p>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Email</label>
            <input type="email" value={email}
              onChange={e => { setEmail(e.target.value); setErr(""); }}
              onKeyDown={e => e.key === "Enter" && login()}
              placeholder="admin@burgerpoint.co.in"
              autoComplete="email"
              className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-4 py-3 outline-none text-stone-700" />
          </div>
          <div>
            <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Password</label>
            <div className="relative">
              <input type={show ? "text" : "password"} value={pwd}
                onChange={e => { setPwd(e.target.value); setErr(""); }}
                onKeyDown={e => e.key === "Enter" && login()}
                placeholder="••••••••"
                autoComplete="current-password"
                className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-4 py-3 outline-none text-stone-700 pr-10" />
              <button onClick={() => setShow(s => !s)} aria-label="Toggle password visibility" className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400">
                {show ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
        </div>
        {err && <p className="text-red-500 text-xs mt-3 text-center">{err}</p>}
        <button onClick={login} disabled={loading}
          className="w-full mt-5 bg-gradient-to-r from-orange-500 to-red-600 text-white py-4 rounded-2xl font-bold text-sm shadow-md active:scale-95 transition-transform disabled:opacity-60">
          {loading ? "Logging in…" : "🔐 Login"}
        </button>
        <button onClick={() => window.location.hash = ""} className="w-full mt-3 text-xs text-stone-400 underline">← Back to menu</button>
      </div>
    </div>
  );
}

function RideServiceButtons({ order }) {
  const [copiedAddr, setCopiedAddr] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);

  const custAddr  = order.delivery_address || "";
  const custLat   = order.customer_lat;
  const custLng   = order.customer_lng;
  const custPhone = order.customer_phone || order.phone || "";

  const copyAddress = async () => {
    const addr = (custLat && custLng)
      ? `${custAddr} (${Number(custLat).toFixed(6)}, ${Number(custLng).toFixed(6)})`
      : custAddr;
    try { await navigator.clipboard.writeText(addr); } catch (_) {}
    setCopiedAddr(true);
    setTimeout(() => setCopiedAddr(false), 2500);
  };

  const copyPhone = async () => {
    try { await navigator.clipboard.writeText(custPhone); } catch (_) {}
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2500);
  };

  return (
    <div className="mt-2 flex gap-2">
      <button
        onClick={copyAddress}
        className={`flex-1 flex items-center justify-center gap-1 text-[11px] font-bold py-1.5 rounded-lg active:scale-95 transition-all ${
          copiedAddr ? "bg-emerald-500 text-white" : "bg-blue-100 text-blue-800 hover:bg-blue-200"
        }`}>
        {copiedAddr ? "✅ Copied!" : "📋 Copy Address"}
      </button>
      <button
        onClick={copyPhone}
        disabled={!custPhone}
        className={`flex-1 flex items-center justify-center gap-1 text-[11px] font-bold py-1.5 rounded-lg active:scale-95 transition-all ${
          copiedPhone ? "bg-emerald-500 text-white" : "bg-purple-100 text-purple-800 hover:bg-purple-200"
        } disabled:opacity-40 disabled:cursor-not-allowed`}>
        {copiedPhone ? "✅ Copied!" : "📞 Copy Mobile"}
      </button>
    </div>
  );
}

function CopyPickupButton({ order, earningPerKm }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        const msg = buildPickupMessage(order, earningPerKm);
        try { await navigator.clipboard.writeText(msg); } catch (_) {}
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }}
      className={`w-full mt-2 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-bold active:scale-95 transition-all shadow-sm ${
        copied ? "bg-emerald-500 text-white" : "bg-green-500 text-white hover:bg-green-600"
      }`}>
      {copied ? "✅ Copied! Paste in WhatsApp group" : "📋 Copy Rider Group Message"}
    </button>
  );
}

// ─────────────────────────────────────────────────────────
//  ORDER CARD
// ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────
//  RIDER FALLBACK CONTROLS
//  Admin override when rider hasn't updated their status.
//  Shown inside OrderCard for delivery orders with an assigned rider.
// ─────────────────────────────────────────────────────────
const RIDER_STATUS_STEPS = [
  { rider_status: "assigned",   order_status: null,         label: "Assigned" },
  { rider_status: "accepted",   order_status: null,         label: "Rider Accepted" },
  { rider_status: "picked_up",  order_status: "dispatched", label: "Picked Up / Dispatched" },
  { rider_status: "delivered",  order_status: "served",     label: "Delivered" },
];

function RiderFallbackControls({ order, onAdvance }) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(null); // step label being confirmed
  const currentIdx = RIDER_STATUS_STEPS.findIndex(s => s.rider_status === order.rider_status);

  // Nothing to override if already at last step
  if (currentIdx >= RIDER_STATUS_STEPS.length - 1) return null;

  const next = RIDER_STATUS_STEPS[currentIdx + 1];
  const remaining = RIDER_STATUS_STEPS.slice(currentIdx + 1);

  async function applyOverride(step) {
    setConfirming(null);
    setExpanded(false);
    if (!SUPABASE_READY) return;

    const payload = { rider_status: step.rider_status };
    if (step.rider_status === "picked_up") payload.picked_up_at = new Date().toISOString();
    if (step.rider_status === "delivered") payload.delivered_at = new Date().toISOString();
    if (step.order_status) payload.status = step.order_status;

    const { error } = await supabase.from("orders").update(payload).eq("id", order.id);
    if (error) {
      console.warn("[bp] rider-fallback update failed:", error?.message);
      return;
    }
    // Let the realtime subscription pick it up; also call onAdvance for
    // the order status part so the optimistic update fires immediately.
    if (step.order_status) onAdvance(order.id, step.order_status, { rider_status: step.rider_status, ...payload });
  }

  return (
    <div className="mt-2 border border-dashed border-purple-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-bold text-purple-600 bg-purple-50 active:bg-purple-100">
        <span>🛵 Rider Override {expanded ? "▲" : "▼"}</span>
        <span className="font-normal text-purple-400">
          Current: {RIDER_STATUS_STEPS[currentIdx]?.label ?? "Not set"}
        </span>
      </button>

      {expanded && (
        <div className="px-3 py-2 bg-white flex flex-col gap-1.5">
          <p className="text-[10px] text-stone-400 mb-1">
            Rider hasn't updated? Manually advance their status.
          </p>
          {remaining.map(step => (
            confirming === step.label ? (
              <div key={step.rider_status} className="flex gap-2">
                <button
                  onClick={() => applyOverride(step)}
                  className="flex-1 py-2 rounded-lg text-[11px] font-bold bg-purple-500 text-white active:scale-95 transition-transform">
                  Confirm: {step.label}
                </button>
                <button
                  onClick={() => setConfirming(null)}
                  className="px-3 py-2 rounded-lg text-[11px] font-bold border border-stone-200 text-stone-500">
                  ✕
                </button>
              </div>
            ) : (
              <button
                key={step.rider_status}
                onClick={() => setConfirming(step.label)}
                className="w-full py-2 rounded-lg text-[11px] font-bold border border-purple-200 text-purple-700 bg-purple-50 active:scale-95 transition-transform hover:bg-purple-100">
                Mark as: {step.label}
              </button>
            )
          ))}
        </div>
      )}
    </div>
  );
}

function OrderCard({ order, onAdvance, onCancel, riders, onAssignDispatch, onPrintKOT, onPrintInvoice, isAddOn }) {
  const [open, setOpen] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const { settings: bizSettings } = useBusinessSettings();
  const earningPerKm = Number(bizSettings?.earning_per_km ?? 10);
  const ns = getNextStep(order);
  const cfg = STATUS_CFG[order.status] || STATUS_CFG.pending;
  const typeEmoji = order.order_type === "delivery" ? "🛵" : order.order_type === "takeaway" ? "📦" : "🍽️";
  const isUnconfirmed = order.status === "pending";
  // Terminal statuses — no actions allowed at all. NOTE: for dine-in/takeaway,
  // "served" is NOT terminal — the guest may still be at the table (dine-in)
  // or the bill isn't confirmed closed yet (takeaway), so the order stays
  // active until the extra "Clear Table" / "Complete & Close Bill" step.
  const isTerminal = isOrderTerminal(order);
  // Why this served-but-not-done order is still showing up / table still occupied.
  const stillOpenReason = order.status === "served" && order.order_type !== "delivery"
    ? (order.order_type === "takeaway"
        ? "Collected — bill not confirmed closed yet."
        : "Table isn't empty yet — guest may still be seated.")
    : null;

  // ── Pop-in flash when new items get merged onto this order ──────────
  // Fires once staff approve a pending add-on request below — items grows
  // on this same row, so this just gives a brief visual "pop" to notice it.
  const prevItemCountRef = useRef(order.items?.length || 0);
  const [justMerged, setJustMerged] = useState(false);
  useEffect(() => {
    const count = order.items?.length || 0;
    if (count > prevItemCountRef.current) {
      setOpen(true);
      setJustMerged(true);
      const t = setTimeout(() => setJustMerged(false), 1800);
      prevItemCountRef.current = count;
      return () => clearTimeout(t);
    }
    prevItemCountRef.current = count;
  }, [order.items?.length]);

  // ── Add-on request — customer used "Add More Items" on an order that's
  // already placed. Staff must approve before it joins the bill. Auto-open
  // the card so this is impossible to miss.
  const pendingAddon = order.pending_addon_items && order.pending_addon_items.length > 0
    ? order.pending_addon_items : null;
  const prevHadAddonRef = useRef(!!pendingAddon);
  useEffect(() => {
    if (pendingAddon && !prevHadAddonRef.current) setOpen(true);
    prevHadAddonRef.current = !!pendingAddon;
  }, [pendingAddon]);

  async function approveAddon() {
    if (!SUPABASE_READY || !pendingAddon) return;
    const mergedItems = [...(order.items || []), ...pendingAddon];
    const mergedTotal = Number(order.total || 0) + Number(order.pending_addon_total || 0);
    // If the ticket had already been served, new items mean the kitchen
    // has work again — bump it back to "pending" so it re-enters the
    // active queue. If it's still cooking, leave the status as-is.
    const nextStatus = order.status === "served" ? "pending" : order.status;
    const { error } = await supabase.from("orders").update({
      items: mergedItems, total: mergedTotal, status: nextStatus,
      pending_addon_items: null, pending_addon_total: null, addon_requested_at: null,
    }).eq("id", order.id);
    if (error) console.warn("[bp] approve add-on failed:", error.message);
  }

  async function declineAddon() {
    if (!SUPABASE_READY || !pendingAddon) return;
    const { error } = await supabase.from("orders").update({
      pending_addon_items: null, pending_addon_total: null, addon_requested_at: null,
    }).eq("id", order.id);
    if (error) console.warn("[bp] decline add-on failed:", error.message);
  }

  return (
    <div className={`bg-white rounded-2xl border shadow-sm overflow-hidden mb-3 transition-all duration-500 ${justMerged ? "ring-4 ring-amber-300 scale-[1.01] shadow-lg" : ""} ${isAddOn ? "border-amber-400 border-2" : isUnconfirmed ? "border-red-300 border-2" : "border-stone-100"}`}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer" onClick={() => setOpen(o => !o)}>
        <div className="relative">
          <div className="text-xl">{typeEmoji}</div>
          {isUnconfirmed && (
            <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-bold text-stone-800 truncate">
              {order.table_label || order.customer_name || `Order`}
            </p>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full flex-shrink-0 ${cfg.color}`}>{cfg.label}</span>
            {isUnconfirmed && (
              <span className="text-[10px] font-black text-red-600 flex-shrink-0">● NOT CONFIRMED</span>
            )}
            {isAddOn && (
              <span className="text-[10px] font-black text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full flex-shrink-0 flex items-center gap-0.5">
                ➕ Add-on
              </span>
            )}
            {justMerged && (
              <span className="text-[10px] font-black text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full flex-shrink-0 flex items-center gap-0.5 animate-bounce">
                🆕 Items Added
              </span>
            )}
            {pendingAddon && (
              <span className="text-[10px] font-black text-white bg-purple-600 px-2 py-0.5 rounded-full flex-shrink-0 flex items-center gap-0.5 animate-pulse">
                🔔 Wants to add items
              </span>
            )}
          </div>
          {stillOpenReason && (
            <p className="text-[10px] text-amber-600 font-semibold mt-0.5">⚠️ {stillOpenReason}</p>
          )}
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-stone-400">{order.time}</span>
            {order.customer_phone && <span className="text-xs text-stone-400">{order.customer_phone}</span>}
            <span className="text-xs font-bold text-orange-600">{currency(order.total)}</span>
            {order.payment_method && <span className="text-[10px] bg-stone-100 text-stone-500 px-1.5 py-0.5 rounded-md">{order.payment_method}</span>}
          </div>
        </div>
        {open ? <ChevronUp size={14} className="text-stone-400 flex-shrink-0" /> : <ChevronDown size={14} className="text-stone-400 flex-shrink-0" />}
      </div>

      {open && (
        <div className="border-t border-stone-100 px-4 pb-4">
          {/* Pending add-on request — needs approval before it joins the bill */}
          {pendingAddon && (
            <div className="mt-3 bg-purple-50 border-2 border-purple-300 rounded-2xl p-3">
              <p className="text-xs font-black text-purple-700 flex items-center gap-1.5">
                🔔 {order.table_label || order.customer_name || "This customer"} wants to add these to their current order:
              </p>
              <div className="mt-2 mb-2">
                {pendingAddon.map((it, i) => (
                  <div key={i} className="flex justify-between text-sm py-0.5">
                    <span className="text-stone-700">{it.name}{it.selectedVariant ? ` (${it.selectedVariant})` : ""} ×{it.qty}</span>
                    <span className="text-stone-500 font-semibold">{currency(it.finalPrice * it.qty)}</span>
                  </div>
                ))}
                <div className="flex justify-between text-xs font-bold text-purple-700 pt-1 border-t border-purple-200 mt-1">
                  <span>Add-on total</span><span>+{currency(order.pending_addon_total)}</span>
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={approveAddon}
                  className="flex-1 py-2 rounded-xl text-xs font-bold bg-purple-600 text-white active:scale-95 transition-transform">
                  ✅ Approve — add to bill
                </button>
                <button onClick={declineAddon}
                  className="px-3 py-2 rounded-xl text-xs font-bold border border-purple-300 text-purple-600 active:scale-95 transition-transform">
                  ✕ Decline
                </button>
              </div>
              <p className="text-[10px] text-purple-400 mt-2">Once approved, both the original and new items show together — on one bill.</p>
            </div>
          )}

          {/* Items */}
          <div className="py-3">
            {(order.items || []).map((it, i) => (
              <div key={i} className="flex justify-between text-sm py-0.5">
                <span className="text-stone-700">
                  {it.name}{it.selectedVariant ? ` (${it.selectedVariant})` : ""} ×{it.qty}
                  {it.addonLabels?.length > 0 && <span className="text-[11px] text-orange-400 ml-1">({it.addonLabels.join(", ")})</span>}
                </span>
                <span className="text-stone-500 font-semibold">{currency(it.finalPrice * it.qty)}</span>
              </div>
            ))}
            {order.note && <p className="text-xs text-stone-400 italic mt-2">"{order.note}"</p>}
            {order.delivery_address && (
              <div className="mt-2 bg-stone-50 rounded-xl p-2">
                <p className="text-xs text-stone-500 mb-2">📍 {order.delivery_address}</p>
                {order.customer_lat && order.customer_lng && (
                  <p className="text-[10px] text-blue-500 font-mono mb-2">
                    📌 {Number(order.customer_lat).toFixed(6)}, {Number(order.customer_lng).toFixed(6)}
                  </p>
                )}
                <div className="flex gap-2">
                  <a
                    href={
                      order.customer_lat && order.customer_lng
                        ? `https://maps.google.com/?q=${order.customer_lat},${order.customer_lng}`
                        : `https://maps.google.com/?q=${encodeURIComponent(order.delivery_address)}`
                    }
                    target="_blank" rel="noopener noreferrer"
                    className="flex-1 flex items-center justify-center gap-1.5 bg-blue-500 text-white text-[11px] font-bold py-1.5 rounded-lg">
                    🗺️ Google Maps
                  </a>
                  {order.rider_phone ? (
                    <a
                      href={`https://wa.me/91${order.rider_phone}?text=${encodeURIComponent(
                        `🛵 *Delivery Address:*
${order.delivery_address}

📍 Exact Location:
https://maps.google.com/?q=${order.customer_lat},${order.customer_lng}`
                      )}`}
                      target="_blank" rel="noopener noreferrer"
                      className="flex-1 flex items-center justify-center gap-1.5 bg-green-500 text-white text-[11px] font-bold py-1.5 rounded-lg">
                      💬 {order.rider_name || "Rider"}
                    </a>
                  ) : (
                    <div className="flex-1 flex items-center justify-center gap-1.5 bg-stone-200 text-stone-400 text-[11px] font-bold py-1.5 rounded-lg">
                      💬 Assign Rider First
                    </div>
                  )}
                </div>
                <RideServiceButtons order={order} bizSettings={bizSettings} />
              </div>
            )}
            {order.promo_code && (
              <p className="text-xs text-green-600 mt-1">🏷️ Promo: {order.promo_code} (−{currency(order.discount)})</p>
            )}
          </div>

          {/* Rider info */}
          {order.rider_name && (
            <div className="bg-purple-50 rounded-xl px-3 py-2 mb-3 flex items-center gap-2">
              <Bike size={13} className="text-purple-600" />
              <span className="text-xs font-bold text-purple-700">{order.rider_name}</span>
              {order.rider_phone && <span className="text-xs text-purple-500">{order.rider_phone}</span>}
            </div>
          )}

          {/* Action — hidden for terminal statuses (cancelled / served) */}
          {ns && !isTerminal && (
            <button
              onClick={() => {
                if (ns.next === "dispatched") { onAssignDispatch(order.id); }
                else {
                  if (ns.next === "accepted" && onPrintKOT) onPrintKOT(order);
                  onAdvance(order.id, ns.next);
                }
              }}
              className="w-full bg-gradient-to-r from-orange-500 to-red-500 text-white py-2.5 rounded-xl text-xs font-bold shadow-sm active:scale-95 transition-transform">
              {ns.next === "accepted" ? "✅ Accept & Print KOT 🍳" : ns.label}
            </button>
          )}

          {/* Rider fallback — admin can manually advance rider/order status
              when rider hasn't updated. Only shown for delivery orders with
              an assigned rider that aren't terminal yet. */}
          {order.order_type === "delivery" && order.rider_id && !isTerminal && (
            <RiderFallbackControls order={order} onAdvance={onAdvance} />
          )}

          {/* Cancelled banner — shown instead of action buttons */}
          {order.status === "cancelled" && (
            <div className="w-full bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-center">
              <p className="text-xs font-bold text-red-600">✕ Order Cancelled</p>
              {order.cancel_reason && <p className="text-[11px] text-red-400 mt-0.5">{order.cancel_reason}</p>}
            </div>
          )}

          {/* Print Bill + WhatsApp rider — side by side */}
          <div className="flex gap-2 mt-2">
            {onPrintInvoice && (
              <button
                onClick={() => onPrintInvoice(order)}
                className="flex-1 flex items-center justify-center gap-1.5 border-2 border-stone-200 text-stone-600 py-2 rounded-xl text-xs font-bold active:scale-95 transition-transform hover:border-orange-300 hover:text-orange-600">
                <Printer size={12} /> Print Bill
              </button>
            )}
            {order.rider_phone && (
              <a
                href={`https://wa.me/91${order.rider_phone.replace(/\D/g,"")}?text=${encodeURIComponent(
                  `🛵 *New Order — ${order.table_label || order.customer_name || "Order"}*\n\n` +
                  (order.items || []).map(it => `• ${it.name}${it.selectedVariant ? ` (${it.selectedVariant})` : ""} ×${it.qty}`).join("\n") +
                  `\n\n💰 Total: ₹${order.total}` +
                  (order.delivery_address ? `\n\n📍 Deliver to: ${order.delivery_address}` : "") +
                  (order.customer_lat && order.customer_lng ? `\n🗺️ https://maps.google.com/?q=${order.customer_lat},${order.customer_lng}` : "") +
                  (order.note ? `\n\n📝 Note: ${order.note}` : "")
                )}`}
                target="_blank" rel="noopener noreferrer"
                className="flex-1 flex items-center justify-center gap-1.5 bg-green-500 text-white py-2 rounded-xl text-xs font-bold active:scale-95 transition-transform hover:bg-green-600">
                💬 WhatsApp Rider
              </a>
            )}
          </div>

          {/* Copy Rider Request — copies pickup message for delivery orders */}
          {order.order_type === "delivery" && (
            <CopyPickupButton order={order} earningPerKm={earningPerKm} />
          )}

          {/* Cancel order — only shown for active (non-terminal) orders */}
          {onCancel && !isTerminal && (
            <button
              onClick={() => setShowCancel(true)}
              className="w-full mt-2 flex items-center justify-center gap-1.5 border-2 border-red-100 text-red-500 py-2 rounded-xl text-xs font-bold active:scale-95 transition-transform hover:border-red-300 hover:bg-red-50">
              <XCircle size={12} /> Cancel Order
            </button>
          )}
        </div>
      )}

      {showCancel && (
        <CancelOrderModal
          order={order}
          onConfirm={(reasonId) => { onCancel(order.id, reasonId); setShowCancel(false); }}
          onClose={() => setShowCancel(false)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  CANCEL ORDER MODAL — admin picks one of 5 preset reasons
// ─────────────────────────────────────────────────────────
function CancelOrderModal({ order, onConfirm, onClose }) {
  const [selected, setSelected] = useState(null);

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/50" onClick={onClose}>
      <div className="w-full max-w-lg bg-white rounded-t-3xl p-5 pb-7" onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 bg-stone-200 rounded-full mx-auto mb-4" />
        <p className="font-black text-stone-800 text-base mb-1">Cancel this order?</p>
        <p className="text-xs text-stone-400 mb-4">
          {order.table_label || order.customer_name || "This order"} · {currency(order.total)} — the customer will see the reason you pick below.
        </p>
        <div className="space-y-2 mb-5">
          {CANCEL_REASONS.map(r => (
            <button key={r.id} onClick={() => setSelected(r.id)}
              className={`w-full text-left px-4 py-3 rounded-xl text-sm font-semibold border-2 transition-all ${selected === r.id ? "border-red-400 bg-red-50 text-red-700" : "border-stone-100 text-stone-600"}`}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button onClick={onClose}
            className="flex-1 py-3 rounded-xl text-sm font-bold border-2 border-stone-200 text-stone-600">
            Keep Order
          </button>
          <button onClick={() => selected && onConfirm(selected)} disabled={!selected}
            className="flex-1 py-3 rounded-xl text-sm font-bold bg-red-500 text-white disabled:opacity-40">
            Cancel Order
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  ASSIGN RIDER MODAL
// ─────────────────────────────────────────────────────────
function AssignModal({ orderId, onAssign, onClose }) {
  const [sel, setSel]         = useState(null); // full rider object
  const [dbRiders, setDbRiders] = useState([]);
  const [loading, setLoading]  = useState(true);

  useEffect(() => {
    supabase.from("riders").select("*").eq("active", true).eq("availability", "Available").order("full_name")
      .then(({ data }) => { setDbRiders(data || []); setLoading(false); });
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full bg-white rounded-t-3xl max-w-lg mx-auto p-6" onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 bg-stone-200 rounded-full mx-auto mb-4" />
        <h3 className="font-bold text-stone-800 text-base mb-4 flex items-center gap-2"><Bike size={16} className="text-purple-500" /> Assign Rider</h3>
        {loading ? (
          <div className="flex justify-center py-6"><RefreshCw size={18} className="animate-spin text-stone-400" /></div>
        ) : dbRiders.length === 0 ? (
          <p className="text-sm text-stone-400 text-center py-4">No available riders. Add in Riders tab.</p>
        ) : (
          <div className="space-y-2 mb-4">
            {dbRiders.map(r => (
              <button key={r.id} onClick={() => setSel(r)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 transition-all ${sel?.id === r.id ? "border-purple-400 bg-purple-50" : "border-stone-100 bg-stone-50"}`}>
                <div className="w-8 h-8 bg-purple-100 rounded-full flex items-center justify-center text-sm">🛵</div>
                <div className="text-left flex-1">
                  <p className="text-sm font-bold text-stone-800">{r.full_name}</p>
                  <p className="text-xs text-stone-400">{r.phone_number} · {r.rider_id}</p>
                </div>
                <span className="text-[10px] font-bold bg-green-100 text-green-700 px-2 py-0.5 rounded-full">{r.availability}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-3 rounded-xl border-2 border-stone-200 text-stone-500 text-sm font-bold">Cancel</button>
          <button onClick={() => { if (sel) onAssign(orderId, sel); }} disabled={!sel}
            className="flex-1 py-3 rounded-xl bg-gradient-to-r from-purple-500 to-purple-600 text-white text-sm font-bold disabled:opacity-50">
            Dispatch 🛵
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  POS BILLING TAB
// ─────────────────────────────────────────────────────────
const ORDER_SOURCES = ["Walk-in", "Zomato", "Swiggy", "Phone Call", "Website"];

function BillingTab({ bizSettings }) {
  const isMobile = window.innerWidth < 768;
  if (isMobile) return <MobileBillingTab bizSettings={bizSettings} />;

  const [menuItems,    setMenuItems]    = useState([]);
  const [search,       setSearch]       = useState("");
  const [cart,         setCart]         = useState([]);  // { id, name, price, qty, isCustom }
  const [source,       setSource]       = useState("Walk-in");
  const [orderType,    setOrderType]    = useState("dine-in");
  const [custName,     setCustName]     = useState("");
  const [custPhone,    setCustPhone]    = useState("");
  const [tableLabel,   setTableLabel]   = useState("");
  const [note,         setNote]         = useState("");
  const [payMethod,    setPayMethod]    = useState("Cash");
  const [discount,     setDiscount]     = useState(0);
  const [activeCat,    setActiveCat]    = useState(null);
  // misc custom item
  const [showCustom,   setShowCustom]   = useState(false);
  const [customName,   setCustomName]   = useState("");
  const [customPrice,  setCustomPrice]  = useState("");
  // placing
  const [placing,      setPlacing]      = useState(false);
  const [printErr,     setPrintErr]     = useState("");
  const [lastOrder,    setLastOrder]    = useState(null);
  const toast = useToast();

  // Load menu — Supabase first, fall back to DEFAULT_MENU
  useEffect(() => {
    (async () => {
      if (!SUPABASE_READY) { setMenuItems(ALL_ITEMS); return; }
      const { data, error } = await supabase
        .from("menu_items")
        .select("id,name,category,price,price_half,price_full,price_regular,price_large,is_available")
        .order("category").order("name");
      if (error || !data || data.length === 0) {
        setMenuItems(ALL_ITEMS);
      } else {
        // Merge: Supabase items take priority; any DEFAULT_MENU item not in Supabase is appended
        const sbIds = new Set(data.map(i => i.id));
        const fallback = ALL_ITEMS.filter(i => !sbIds.has(i.id));
        setMenuItems([...data, ...fallback]);
      }
    })();
  }, []);

  // Cart helpers
  const addItem = (item, variant = null) => {
    const price = variant === "Half"    ? item.price_half
                : variant === "Full"    ? item.price_full
                : variant === "Regular" ? item.price_regular
                : variant === "Large"   ? item.price_large
                : item.price;
    const key = item.id + (variant || "");
    setCart(prev => {
      const idx = prev.findIndex(c => c.key === key);
      if (idx >= 0) return prev.map((c, i) => i === idx ? { ...c, qty: c.qty + 1 } : c);
      return [...prev, { key, id: item.id, name: item.name + (variant ? ` (${variant})` : ""), price: Number(price || item.price || 0), qty: 1 }];
    });
  };

  const addCustomItem = () => {
    if (!customName.trim() || !customPrice || isNaN(Number(customPrice))) return;
    const key = "custom_" + Date.now();
    setCart(prev => [...prev, { key, id: key, name: customName.trim(), price: Number(customPrice), qty: 1, isCustom: true }]);
    setCustomName(""); setCustomPrice(""); setShowCustom(false);
  };

  const changeQty = (key, delta) => {
    setCart(prev => prev
      .map(c => c.key === key ? { ...c, qty: c.qty + delta } : c)
      .filter(c => c.qty > 0)
    );
  };

  const gstPct    = Number(bizSettings?.gst_percent ?? 5);
  const packing   = orderType === "takeaway" ? Number(bizSettings?.packing_charge ?? 0) : 0;
  const subtotal  = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const discAmt   = Math.min(Number(discount) || 0, subtotal);
  const taxable   = subtotal - discAmt;
  const gstAmt    = Math.round(taxable * gstPct / 100);
  const grandTotal = taxable + packing + gstAmt;

  // Filtered menu for search
  const visible = search.trim()
    ? menuItems.filter(i => i.name.toLowerCase().includes(search.toLowerCase()))
    : menuItems;

  // Group for display
  const grouped = {};
  visible.forEach(i => { if (!grouped[i.category]) grouped[i.category] = []; grouped[i.category].push(i); });

  const buildOrderPayload = () => {
    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
    return ({
    id: crypto.randomUUID(),
    order_type: orderType,
    source,
    platform: source !== "Walk-in" ? source : null,
    customer_name: custName.trim() || null,
    customer_phone: custPhone.trim() || null,
    table_label: tableLabel.trim() || null,
    payment_method: payMethod,
    items: cart.map(c => ({ name: c.name, selectedVariant: null, finalPrice: c.price, qty: c.qty, addonLabels: [] })),
    total: grandTotal,
    discount: discAmt,
    packing_charge: packing,
    gst_amount: gstAmt,
    note: note.trim() || "",
    status: "accepted",  // POS bills go straight to accepted
    time: timeStr,
    created_at: now.toISOString(),
  });};

  const handleBill = async () => {
    if (cart.length === 0) { toast.error("Add at least one item."); return; }
    setPlacing(true); setPrintErr("");
    const payload = buildOrderPayload();

    // 1 — Save to Supabase
    if (SUPABASE_READY) {
      const { error } = await supabase.from("orders").insert(payload);
      if (error) {
        setPrintErr("⚠️ Order not saved — " + error.message + ". Print anyway?");
        setPlacing(false);
        // Don't clear cart or proceed — admin must retry or acknowledge
        return;
      }
    }

    // 2 — Print invoice via Windows print dialog
    try {
      printInvoice(payload, bizSettings);
      toast.success("Billed & print dialog opened ✓");
    } catch (e) {
      setPrintErr(e.message || "Print failed — order saved.");
    }

    setLastOrder(payload);
    setCart([]);
    setNote(""); setDiscount(0);
    setCustName(""); setCustPhone(""); setTableLabel("");
    setPlacing(false);
  };

  const handleReprint = () => {
    if (!lastOrder) return;
    try {
      printInvoice(lastOrder, bizSettings);
      toast.success("Reprinted ✓");
    } catch (e) {
      setPrintErr(e.message || "Reprint failed.");
    }
  };


  // Print KOT only (no save)
  const handlePrintKOT = () => {
    if (cart.length === 0) { toast.error("Add at least one item."); return; }
    try {
      const payload = buildOrderPayload();
      printKOT(payload);
      toast.success("🍳 KOT sent to kitchen");
    } catch (e) {
      setPrintErr(e.message || "KOT print failed.");
    }
  };

  // Save order + print bill only (no KOT)
  const handleBillOnly = async () => {
    if (cart.length === 0) { toast.error("Add at least one item."); return; }
    setPlacing(true); setPrintErr("");
    const payload = buildOrderPayload();
    if (SUPABASE_READY) {
      const { error } = await supabase.from("orders").insert(payload);
      if (error) {
        setPrintErr("⚠️ Order not saved — " + error.message);
        setPlacing(false);
        return;
      }
    }
    try {
      printInvoice(payload, bizSettings);
      toast.success("🧾 Bill printed");
    } catch (e) {
      setPrintErr(e.message || "Print failed — order saved.");
    }
    setLastOrder(payload);
    setCart([]); setNote(""); setDiscount(0);
    setCustName(""); setCustPhone(""); setTableLabel("");
    setPlacing(false);
  };

  const categories = Object.keys(grouped);

  // Height of the POS area below the top bar — fills the viewport
  const POS_H = "calc(100vh - 190px)";

  return (
    <div className="flex flex-col h-full">

      {/* ── Top bar: order type · source · customer fields ── */}
      <div className="bg-white border-b border-stone-100 px-4 py-2.5 flex flex-wrap items-center gap-2 flex-shrink-0">
        {/* Order type */}
        <div className="flex gap-1">
          {[["dine-in","🍽️ Dine-In"],["takeaway","📦 Takeaway"],["delivery","🛵 Delivery"]].map(([v,l]) => (
            <button key={v} onClick={() => setOrderType(v)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${orderType === v ? "bg-stone-800 text-white" : "bg-stone-100 text-stone-500 hover:bg-stone-200"}`}>
              {l}
            </button>
          ))}
        </div>
        {/* Source */}
        <div className="flex gap-1 flex-wrap">
          {ORDER_SOURCES.map(s => (
            <button key={s} onClick={() => setSource(s)}
              className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all ${source === s ? "bg-orange-500 text-white" : "bg-stone-100 text-stone-500 hover:bg-stone-200"}`}>
              {s}
            </button>
          ))}
        </div>
        {/* Customer fields */}
        <div className="flex gap-1.5 ml-auto flex-wrap">
          <input value={custName} onChange={e => setCustName(e.target.value)} placeholder="Customer name"
            className="w-32 text-xs border border-stone-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-orange-400" />
          <input value={custPhone} onChange={e => setCustPhone(e.target.value.replace(/\D/g,"").slice(0,10))} placeholder="Phone" inputMode="numeric"
            className="w-24 text-xs border border-stone-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-orange-400" />
          {orderType === "dine-in" && (
            <input value={tableLabel} onChange={e => setTableLabel(e.target.value)} placeholder="Table"
              className="w-20 text-xs border border-stone-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-orange-400" />
          )}
        </div>
      </div>

      {/* ── POS body: [category rail] [item grid] [bill panel] ── */}
      <div className="flex gap-0 flex-1 overflow-hidden" style={{ height: POS_H }}>

        {/* ── Category rail ── */}
        <div className="w-36 flex-shrink-0 flex flex-col border-r border-stone-100 bg-white overflow-hidden">
          {/* Sticky search */}
          <div className="flex-shrink-0 px-1.5 pt-2 pb-1">
            <div className="flex items-center gap-1 bg-stone-100 rounded-lg px-2 py-1.5">
              <Search size={11} className="text-stone-400 flex-shrink-0" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
                className="w-full text-[11px] bg-transparent outline-none text-stone-700 placeholder-stone-400" />
              {search && <button onClick={() => setSearch("")} aria-label="Clear search"><X size={10} className="text-stone-400" /></button>}
            </div>
          </div>
          {/* Scrollable category list */}
          <div className="flex-1 overflow-y-auto px-1.5 pb-2 space-y-0.5">
          {categories.map(cat => (
            <button key={cat}
              onClick={() => { setActiveCat(cat); document.getElementById(`pos-cat-${cat}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
              className={`w-full text-left px-2.5 py-2 rounded-lg text-[11px] font-bold transition-colors capitalize truncate
                ${activeCat === cat ? "bg-orange-500 text-white shadow-sm" : "text-stone-600 hover:bg-orange-50 hover:text-orange-600"}`}>
              {cat}
            </button>
          ))}
          <button onClick={() => setShowCustom(s => !s)}
            className={`w-full text-left px-2.5 py-2 rounded-lg text-[11px] font-bold flex items-center gap-1 mt-1 transition-colors ${showCustom ? "bg-orange-500 text-white" : "bg-orange-50 text-orange-600 hover:bg-orange-100"}`}>
            <Plus size={11} /> Custom
          </button>
          </div>
        </div>

        {/* ── Item grid ── */}
        <div className="flex-1 overflow-y-auto bg-stone-50 px-3 py-2">
          {/* Custom item form */}
          {showCustom && (
            <div className="flex gap-2 items-center bg-white border border-orange-200 rounded-xl px-3 py-2 mb-3">
              <input value={customName} onChange={e => setCustomName(e.target.value)} placeholder="Item name"
                className="flex-1 text-xs border border-stone-200 rounded-lg px-2.5 py-2 outline-none focus:border-orange-400" />
              <input value={customPrice} onChange={e => setCustomPrice(e.target.value)} placeholder="₹ Price" inputMode="numeric" type="number"
                className="w-24 text-xs border border-stone-200 rounded-lg px-2.5 py-2 outline-none focus:border-orange-400" />
              <button onClick={addCustomItem}
                className="bg-orange-500 text-white text-xs font-bold px-4 py-2 rounded-lg flex-shrink-0 hover:bg-orange-600 transition-colors">
                Add
              </button>
              <button onClick={() => setShowCustom(false)} className="text-stone-400 hover:text-stone-600"><X size={14} /></button>
            </div>
          )}

          {/* Category sections */}
          <div className="space-y-4">
            {Object.entries(grouped).map(([cat, items]) => (
              <div key={cat} id={`pos-cat-${cat}`} className="scroll-mt-2">
                <p className="text-[10px] font-black text-stone-400 uppercase tracking-widest mb-2 px-0.5">{cat}</p>
                <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
                  {items.map(item => {
                    const hasVariants = item.price_half || item.price_full || item.price_regular || item.price_large;
                    // Total qty of this item across all variants in cart
                    const itemQty = cart.filter(c => c.id === item.id).reduce((s, c) => s + c.qty, 0);
                    const baseKey = item.id + "";
                    return (
                      <div key={item.id}
                        onClick={!hasVariants ? () => addItem(item) : undefined}
                        className={`bg-white border-2 rounded-xl p-2.5 flex flex-col min-h-[72px] transition-all
                          ${itemQty > 0 ? "border-orange-400 shadow-sm" : "border-stone-100"}
                          ${!hasVariants ? "cursor-pointer hover:border-orange-300 hover:shadow-sm active:scale-[0.98]" : ""}`}>
                        <p className="text-[11px] font-bold text-stone-800 leading-tight mb-1.5 flex-1">{item.name}</p>
                        {hasVariants ? (
                          <div className="flex flex-wrap gap-1">
                            {[
                              item.price_half    && ["Half",    item.price_half,    "½"],
                              item.price_full    && ["Full",    item.price_full,    "F"],
                              item.price_regular && ["Regular", item.price_regular, "R"],
                              item.price_large   && ["Large",   item.price_large,   "L"],
                            ].filter(Boolean).map(([variant, price, label]) => {
                              const vKey = item.id + variant;
                              const vQty = cart.find(c => c.key === vKey)?.qty || 0;
                              return vQty > 0 ? (
                                <div key={variant} className="flex items-center gap-0.5 bg-orange-500 rounded-md px-1 py-0.5" onClick={e => e.stopPropagation()}>
                                  <button onClick={e => { e.stopPropagation(); changeQty(vKey, -1); }} className="text-white font-black text-xs w-4 h-4 flex items-center justify-center">−</button>
                                  <span className="text-white font-black text-[10px] w-3 text-center">{vQty}</span>
                                  <button onClick={e => { e.stopPropagation(); addItem(item, variant); }} className="text-white font-black text-xs w-4 h-4 flex items-center justify-center">+</button>
                                </div>
                              ) : (
                                <button key={variant} onClick={e => { e.stopPropagation(); addItem(item, variant); }}
                                  className="text-[10px] font-bold bg-orange-50 text-orange-600 border border-orange-200 px-1.5 py-0.5 rounded hover:bg-orange-100 transition-colors">
                                  {label} ₹{price}
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="flex items-center justify-between mt-auto" onClick={e => e.stopPropagation()}>
                            <span className="text-[11px] text-orange-600 font-black">₹{item.price}</span>
                            {itemQty > 0 ? (
                              <div className="flex items-center gap-1 bg-orange-500 rounded-lg px-1.5 py-0.5">
                                <button onClick={e => { e.stopPropagation(); changeQty(baseKey, -1); }} className="text-white font-black text-sm w-5 h-5 flex items-center justify-center">−</button>
                                <span className="text-white font-black text-xs w-4 text-center">{itemQty}</span>
                                <button onClick={e => { e.stopPropagation(); addItem(item); }} className="text-white font-black text-sm w-5 h-5 flex items-center justify-center">+</button>
                              </div>
                            ) : (
                              <button onClick={e => { e.stopPropagation(); addItem(item); }} className="w-6 h-6 rounded-md bg-orange-500 text-white flex items-center justify-center flex-shrink-0 hover:bg-orange-600 active:scale-95 transition-all">
                                <Plus size={13} />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            {Object.keys(grouped).length === 0 && (
              <div className="text-center py-16 text-stone-400 text-sm">No items match "{search}"</div>
            )}
          </div>
        </div>

        {/* ── Bill panel ── */}
        <div className="w-72 flex-shrink-0 flex flex-col border-l border-stone-100 bg-white overflow-hidden">
          {/* Header */}
          <div className="px-4 py-2.5 border-b border-stone-100 flex items-center justify-between flex-shrink-0">
            <span className="text-[11px] font-black text-stone-600 uppercase tracking-widest">Bill</span>
            <span className="text-[11px] text-stone-400 font-semibold">{cart.reduce((s,c) => s+c.qty, 0)} items</span>
          </div>

          {/* Cart items — scrollable */}
          <div className="flex-1 overflow-y-auto">
            {cart.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center px-4 py-8">
                <span className="text-3xl mb-2">🧾</span>
                <p className="text-xs text-stone-400 font-medium">Tap items to add them to the bill</p>
              </div>
            ) : (
              <div>
                {cart.map(c => (
                  <div key={c.key} className="flex items-center gap-2 px-3 py-2.5 border-b border-stone-50 last:border-0 hover:bg-stone-50 transition-colors">
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-bold text-stone-800 leading-tight truncate">{c.name}</p>
                      <p className="text-[10px] text-orange-600 font-bold mt-0.5">₹{c.price} × {c.qty} = <span className="text-stone-700">₹{c.price * c.qty}</span></p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button onClick={() => changeQty(c.key, -1)} className="w-6 h-6 rounded bg-stone-100 flex items-center justify-center text-stone-600 text-sm font-bold hover:bg-stone-200 transition-colors">−</button>
                      <span className="text-xs font-black w-5 text-center text-stone-800">{c.qty}</span>
                      <button onClick={() => changeQty(c.key, +1)} className="w-6 h-6 rounded bg-orange-500 text-white flex items-center justify-center font-bold text-sm hover:bg-orange-600 transition-colors">+</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Totals + payment + actions — pinned to bottom */}
          {cart.length > 0 && (
            <div className="flex-shrink-0 border-t border-stone-100">
              {/* Totals */}
              <div className="px-4 py-2.5 bg-stone-50 space-y-1.5">
                <div className="flex justify-between text-xs text-stone-600">
                  <span>Subtotal</span><span className="font-semibold">₹{subtotal}</span>
                </div>
                <div className="flex items-center justify-between text-xs text-stone-600">
                  <span>Discount (₹)</span>
                  <input value={discount} onChange={e => setDiscount(e.target.value)} type="number" min="0"
                    className="w-20 text-right text-xs border border-stone-200 rounded-md px-2 py-0.5 outline-none focus:border-orange-400 bg-white" />
                </div>
                {packing > 0 && (
                  <div className="flex justify-between text-xs text-stone-600"><span>Packing</span><span>₹{packing}</span></div>
                )}
                {gstAmt > 0 && (
                  <div className="flex justify-between text-xs text-stone-600"><span>GST ({gstPct}%)</span><span>₹{gstAmt}</span></div>
                )}
                <div className="flex justify-between text-sm font-black text-stone-900 pt-1.5 border-t border-stone-200 mt-1">
                  <span>Grand Total</span><span className="text-orange-600">₹{grandTotal}</span>
                </div>
              </div>

              {/* Payment method */}
              <div className="px-3 py-2.5 border-t border-stone-100">
                <div className="flex gap-1 mb-2">
                  {["Cash","UPI","Card","Online"].map(m => (
                    <button key={m} onClick={() => setPayMethod(m)}
                      className={`flex-1 py-1.5 rounded-lg text-[10px] font-bold transition-all ${payMethod === m ? "bg-stone-800 text-white" : "bg-stone-100 text-stone-600 hover:bg-stone-200"}`}>
                      {m}
                    </button>
                  ))}
                </div>
                <input value={note} onChange={e => setNote(e.target.value)} placeholder="Note (e.g. no onion)"
                  className="w-full text-[11px] border border-stone-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-orange-400" />
              </div>

              {/* Error + actions */}
              {printErr && (
                <div className="mx-3 mb-1 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5 flex items-center justify-between gap-2">
                  <p className="text-[10px] text-red-700">{printErr}</p>
                  <button onClick={handleReprint} className="text-[10px] font-bold text-red-600 underline flex-shrink-0">Retry</button>
                </div>
              )}
              <div className="px-3 pb-3 pt-1 space-y-1.5">
                {/* KOT + Bill side by side */}
                <div className="flex gap-1.5">
                  <button onClick={handlePrintKOT} disabled={placing || cart.length === 0}
                    className="flex-1 flex items-center justify-center gap-1 bg-amber-500 hover:bg-amber-600 text-white text-[11px] font-black py-2.5 rounded-xl shadow-sm disabled:opacity-50 active:scale-95 transition-all">
                    🍳 Print KOT
                  </button>
                  <button onClick={handleBillOnly} disabled={placing || cart.length === 0}
                    className="flex-1 flex items-center justify-center gap-1 bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-black py-2.5 rounded-xl shadow-sm disabled:opacity-50 active:scale-95 transition-all">
                    <Printer size={11} /> Print Bill
                  </button>
                </div>
                {/* KOT + Bill together (original combined action) */}
                <button onClick={handleBill} disabled={placing || cart.length === 0}
                  className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-orange-500 to-red-500 hover:from-orange-600 hover:to-red-600 text-white font-black text-sm py-3 rounded-xl shadow-md disabled:opacity-50 active:scale-95 transition-all">
                  {placing
                    ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Billing…</>
                    : <><Printer size={14} /> KOT + Bill — ₹{grandTotal}</>}
                </button>
                {/* Reprint last */}
                {lastOrder && (
                  <div className="flex gap-1.5">
                    <button onClick={() => { try { printKOT(lastOrder); toast.success("KOT reprinted"); } catch(e) { setPrintErr(e.message); } }}
                      className="flex-1 flex items-center justify-center gap-1 bg-stone-100 hover:bg-stone-200 text-stone-600 text-[10px] font-bold py-1.5 rounded-xl transition-colors">
                      🍳 Reprint KOT
                    </button>
                    <button onClick={handleReprint}
                      className="flex-1 flex items-center justify-center gap-1 bg-stone-100 hover:bg-stone-200 text-stone-600 text-[10px] font-bold py-1.5 rounded-xl transition-colors">
                      <Printer size={10} /> Reprint Bill
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  MOBILE BILLING TAB
// ─────────────────────────────────────────────────────────
function MobileBillingTab({ bizSettings }) {
  const [menuItems,   setMenuItems]   = useState([]);
  const [search,      setSearch]      = useState("");
  const [cart,        setCart]        = useState([]);
  const [source,      setSource]      = useState("Walk-in");
  const [orderType,   setOrderType]   = useState("dine-in");
  const [custName,    setCustName]    = useState("");
  const [custPhone,   setCustPhone]   = useState("");
  const [tableLabel,  setTableLabel]  = useState("");
  const [note,        setNote]        = useState("");
  const [payMethod,   setPayMethod]   = useState("Cash");
  const [discount,    setDiscount]    = useState(0);
  const [activeCat,   setActiveCat]   = useState(null);
  const [placing,     setPlacing]     = useState(false);
  const [printErr,    setPrintErr]    = useState("");
  const [lastOrder,   setLastOrder]   = useState(null);
  const [showCustom,  setShowCustom]  = useState(false);
  const [customName,  setCustomName]  = useState("");
  const [customPrice, setCustomPrice] = useState("");
  // Mobile specific: which panel is open
  const [showBill,    setShowBill]    = useState(false);
  const [showCheckout,setShowCheckout]= useState(false);
  const toast = useToast();

  useEffect(() => {
    (async () => {
      if (!SUPABASE_READY) { setMenuItems(ALL_ITEMS); return; }
      const { data, error } = await supabase
        .from("menu_items")
        .select("id,name,category,price,price_half,price_full,price_regular,price_large,is_available")
        .order("category").order("name");
      if (error || !data || data.length === 0) {
        setMenuItems(ALL_ITEMS);
      } else {
        const sbIds = new Set(data.map(i => i.id));
        const fallback = ALL_ITEMS.filter(i => !sbIds.has(i.id));
        setMenuItems([...data, ...fallback]);
      }
    })();
  }, []);

  const addItem = (item, variant = null) => {
    const price = variant === "Half"    ? item.price_half
                : variant === "Full"    ? item.price_full
                : variant === "Regular" ? item.price_regular
                : variant === "Large"   ? item.price_large
                : item.price;
    const key = item.id + (variant || "");
    setCart(prev => {
      const idx = prev.findIndex(c => c.key === key);
      if (idx >= 0) return prev.map((c, i) => i === idx ? { ...c, qty: c.qty + 1 } : c);
      return [...prev, { key, id: item.id, name: item.name + (variant ? ` (${variant})` : ""), price: Number(price || item.price || 0), qty: 1 }];
    });
  };

  const addCustomItem = () => {
    if (!customName.trim() || !customPrice || isNaN(Number(customPrice))) return;
    const key = "custom_" + Date.now();
    setCart(prev => [...prev, { key, id: key, name: customName.trim(), price: Number(customPrice), qty: 1, isCustom: true }]);
    setCustomName(""); setCustomPrice(""); setShowCustom(false);
  };

  const changeQty = (key, delta) => {
    setCart(prev => prev.map(c => c.key === key ? { ...c, qty: c.qty + delta } : c).filter(c => c.qty > 0));
  };

  const gstPct    = Number(bizSettings?.gst_percent ?? 5);
  const packing   = orderType === "takeaway" ? Number(bizSettings?.packing_charge ?? 0) : 0;
  const subtotal  = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const discAmt   = Math.min(Number(discount) || 0, subtotal);
  const taxable   = subtotal - discAmt;
  const gstAmt    = Math.round(taxable * gstPct / 100);
  const grandTotal = taxable + packing + gstAmt;
  const totalQty  = cart.reduce((s, c) => s + c.qty, 0);

  const visible = search.trim()
    ? menuItems.filter(i => i.name.toLowerCase().includes(search.toLowerCase()))
    : menuItems;

  const grouped = {};
  visible.forEach(i => { if (!grouped[i.category]) grouped[i.category] = []; grouped[i.category].push(i); });
  const categories = Object.keys(grouped);

  const buildOrderPayload = () => {
    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
    return ({
      id: crypto.randomUUID(),
      order_type: orderType, source,
      platform: source !== "Walk-in" ? source : null,
      customer_name: custName.trim() || null,
      customer_phone: custPhone.trim() || null,
      table_label: tableLabel.trim() || null,
      payment_method: payMethod,
      items: cart.map(c => ({ name: c.name, selectedVariant: null, finalPrice: c.price, qty: c.qty, addonLabels: [] })),
      total: grandTotal, discount: discAmt, packing_charge: packing, gst_amount: gstAmt,
      note: note.trim() || "", status: "accepted", time: timeStr, created_at: now.toISOString(),
    });
  };

  const handleBill = async () => {
    if (cart.length === 0) { toast.error("Add at least one item."); return; }
    setPlacing(true); setPrintErr("");
    const payload = buildOrderPayload();
    if (SUPABASE_READY) {
      const { error } = await supabase.from("orders").insert(payload);
      if (error) { setPrintErr("⚠️ Order not saved — " + error.message); setPlacing(false); return; }
    }
    try { printInvoice(payload, bizSettings); toast.success("Billed & print dialog opened ✓"); }
    catch (e) { setPrintErr(e.message || "Print failed — order saved."); }
    setLastOrder(payload);
    setCart([]); setNote(""); setDiscount(0);
    setCustName(""); setCustPhone(""); setTableLabel("");
    setPlacing(false); setShowBill(false); setShowCheckout(false);
  };

  const handlePrintKOT = () => {
    if (cart.length === 0) { toast.error("Add at least one item."); return; }
    try { printKOT(buildOrderPayload()); toast.success("🍳 KOT sent to kitchen"); }
    catch (e) { setPrintErr(e.message || "KOT print failed."); }
  };

  const handleBillOnly = async () => {
    if (cart.length === 0) { toast.error("Add at least one item."); return; }
    setPlacing(true); setPrintErr("");
    const payload = buildOrderPayload();
    if (SUPABASE_READY) {
      const { error } = await supabase.from("orders").insert(payload);
      if (error) { setPrintErr("⚠️ Order not saved — " + error.message); setPlacing(false); return; }
    }
    try { printInvoice(payload, bizSettings); toast.success("🧾 Bill printed"); }
    catch (e) { setPrintErr(e.message || "Print failed — order saved."); }
    setLastOrder(payload);
    setCart([]); setNote(""); setDiscount(0);
    setCustName(""); setCustPhone(""); setTableLabel("");
    setPlacing(false); setShowBill(false); setShowCheckout(false);
  };

  return (
    <div className="flex flex-col h-full bg-stone-50 relative">

      {/* ── Top bar: order type + source ── */}
      <div className="bg-white border-b border-stone-100 px-3 py-2 flex-shrink-0">
        <div className="flex gap-1.5 mb-2">
          {[["dine-in","🍽️","Dine-In"],["takeaway","📦","Takeaway"],["delivery","🛵","Delivery"]].map(([v,e,l]) => (
            <button key={v} onClick={() => setOrderType(v)}
              className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${orderType === v ? "bg-stone-800 text-white shadow-sm" : "bg-stone-100 text-stone-500"}`}>
              {e} {l}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {ORDER_SOURCES.map(s => (
            <button key={s} onClick={() => setSource(s)}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all ${source === s ? "bg-orange-500 text-white" : "bg-stone-100 text-stone-500"}`}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* ── Category pills (horizontal scroll) ── */}
      <div className="bg-white border-b border-stone-100 flex-shrink-0">
        <div className="flex gap-2 px-3 py-2 overflow-x-auto scrollbar-hide">
          {categories.map(cat => (
            <button key={cat}
              onClick={() => { setActiveCat(cat); document.getElementById(`mpos-cat-${cat}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold capitalize transition-all whitespace-nowrap
                ${activeCat === cat ? "bg-orange-500 text-white shadow-sm" : "bg-stone-100 text-stone-600"}`}>
              {cat}
            </button>
          ))}
          <button onClick={() => setShowCustom(s => !s)}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold flex items-center gap-1 whitespace-nowrap transition-all ${showCustom ? "bg-orange-500 text-white" : "bg-orange-50 text-orange-600"}`}>
            <Plus size={10} /> Custom
          </button>
        </div>
      </div>

      {/* ── Search bar ── */}
      <div className="bg-white px-3 py-2 border-b border-stone-100 flex-shrink-0">
        <div className="flex items-center gap-2 bg-stone-100 rounded-xl px-3 py-2">
          <Search size={13} className="text-stone-400 flex-shrink-0" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search menu..."
            className="flex-1 text-sm bg-transparent outline-none text-stone-700 placeholder-stone-400" />
          {search && <button onClick={() => setSearch("")}><X size={13} className="text-stone-400" /></button>}
        </div>
      </div>

      {/* ── Item list (full width, single column) ── */}
      <div className="flex-1 overflow-y-auto pb-24 px-3 py-2">

        {/* Custom item form */}
        {showCustom && (
          <div className="bg-white border border-orange-200 rounded-2xl p-3 mb-3 space-y-2">
            <p className="text-xs font-black text-stone-700">Custom Item</p>
            <input value={customName} onChange={e => setCustomName(e.target.value)} placeholder="Item name"
              className="w-full text-sm border border-stone-200 rounded-xl px-3 py-2 outline-none focus:border-orange-400" />
            <div className="flex gap-2">
              <input value={customPrice} onChange={e => setCustomPrice(e.target.value)} placeholder="₹ Price" inputMode="numeric" type="number"
                className="flex-1 text-sm border border-stone-200 rounded-xl px-3 py-2 outline-none focus:border-orange-400" />
              <button onClick={addCustomItem}
                className="bg-orange-500 text-white text-sm font-bold px-5 py-2 rounded-xl hover:bg-orange-600 transition-colors">
                Add
              </button>
              <button onClick={() => setShowCustom(false)} className="text-stone-400 px-2"><X size={16} /></button>
            </div>
          </div>
        )}

        {Object.entries(grouped).map(([cat, items]) => (
          <div key={cat} id={`mpos-cat-${cat}`} className="mb-4 scroll-mt-2">
            <p className="text-[10px] font-black text-stone-400 uppercase tracking-widest mb-2">{cat}</p>
            <div className="space-y-2">
              {items.map(item => {
                const hasVariants = item.price_half || item.price_full || item.price_regular || item.price_large;
                const itemQty = cart.filter(c => c.id === item.id).reduce((s, c) => s + c.qty, 0);
                const baseKey = item.id + "";
                return (
                  <div key={item.id}
                    onClick={!hasVariants ? () => addItem(item) : undefined}
                    className={`bg-white rounded-2xl px-4 py-3 flex items-center justify-between border-2 transition-all
                      ${itemQty > 0 ? "border-orange-400 shadow-sm" : "border-transparent shadow-sm"}
                      ${!hasVariants ? "active:scale-[0.98] cursor-pointer" : ""}`}>
                    <div className="flex-1 min-w-0 mr-3">
                      <p className="text-sm font-bold text-stone-800 leading-tight">{item.name}</p>
                      {!hasVariants && <p className="text-sm text-orange-600 font-black mt-0.5">₹{item.price}</p>}
                    </div>
                    {hasVariants ? (
                      <div className="flex flex-wrap gap-1.5 justify-end">
                        {[
                          item.price_half    && ["Half",    item.price_half,    "½"],
                          item.price_full    && ["Full",    item.price_full,    "F"],
                          item.price_regular && ["Regular", item.price_regular, "R"],
                          item.price_large   && ["Large",   item.price_large,   "L"],
                        ].filter(Boolean).map(([variant, price, label]) => {
                          const vKey = item.id + variant;
                          const vQty = cart.find(c => c.key === vKey)?.qty || 0;
                          return vQty > 0 ? (
                            <div key={variant} className="flex items-center gap-1 bg-orange-500 rounded-xl px-2 py-1" onClick={e => e.stopPropagation()}>
                              <button onClick={e => { e.stopPropagation(); changeQty(vKey, -1); }} className="text-white font-black text-sm w-5 h-5 flex items-center justify-center">−</button>
                              <span className="text-white font-black text-xs w-4 text-center">{vQty}</span>
                              <button onClick={e => { e.stopPropagation(); addItem(item, variant); }} className="text-white font-black text-sm w-5 h-5 flex items-center justify-center">+</button>
                            </div>
                          ) : (
                            <button key={variant} onClick={e => { e.stopPropagation(); addItem(item, variant); }}
                              className="text-xs font-bold bg-orange-50 text-orange-600 border border-orange-200 px-2 py-1.5 rounded-xl hover:bg-orange-100 transition-colors">
                              {label} ₹{price}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div onClick={e => e.stopPropagation()}>
                        {itemQty > 0 ? (
                          <div className="flex items-center gap-2 bg-orange-500 rounded-xl px-2 py-1.5">
                            <button onClick={() => changeQty(baseKey, -1)} className="text-white font-black text-base w-6 h-6 flex items-center justify-center">−</button>
                            <span className="text-white font-black text-sm w-5 text-center">{itemQty}</span>
                            <button onClick={() => addItem(item)} className="text-white font-black text-base w-6 h-6 flex items-center justify-center">+</button>
                          </div>
                        ) : (
                          <button onClick={() => addItem(item)}
                            className="w-9 h-9 rounded-xl bg-orange-500 text-white flex items-center justify-center hover:bg-orange-600 active:scale-95 transition-all shadow-sm">
                            <Plus size={18} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {Object.keys(grouped).length === 0 && (
          <div className="text-center py-16 text-stone-400 text-sm">No items match "{search}"</div>
        )}
      </div>

      {/* ── Floating cart button ── */}
      {totalQty > 0 && !showBill && !showCheckout && (
        <div className="fixed bottom-0 left-0 right-0 px-4 pb-4 pt-2 bg-gradient-to-t from-stone-100 to-transparent z-20">
          <button onClick={() => setShowBill(true)}
            className="w-full bg-gradient-to-r from-orange-500 to-red-500 text-white font-black text-base py-4 rounded-2xl shadow-xl flex items-center justify-between px-5 active:scale-[0.98] transition-all">
            <span className="bg-white/20 rounded-lg px-2.5 py-1 text-sm">{totalQty} items</span>
            <span>View Bill</span>
            <span className="text-lg">₹{grandTotal}</span>
          </button>
        </div>
      )}

      {/* ── Bill bottom sheet ── */}
      {showBill && (
        <div className="fixed inset-0 z-30 flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowBill(false)} />
          <div className="relative bg-white rounded-t-3xl max-h-[85vh] flex flex-col">
            {/* Handle */}
            <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
              <div className="w-10 h-1 bg-stone-300 rounded-full" />
            </div>
            {/* Header */}
            <div className="px-4 py-2 flex items-center justify-between flex-shrink-0">
              <span className="font-black text-stone-800 text-base">Your Bill</span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-stone-400 font-semibold">{totalQty} items</span>
                <button onClick={() => setShowBill(false)} className="w-8 h-8 bg-stone-100 rounded-full flex items-center justify-center">
                  <X size={16} className="text-stone-500" />
                </button>
              </div>
            </div>
            {/* Cart items */}
            <div className="flex-1 overflow-y-auto px-4 pb-2">
              {cart.map(c => (
                <div key={c.key} className="flex items-center gap-3 py-3 border-b border-stone-100 last:border-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-stone-800 leading-tight">{c.name}</p>
                    <p className="text-xs text-orange-600 font-bold mt-0.5">₹{c.price} × {c.qty} = <span className="text-stone-700">₹{c.price * c.qty}</span></p>
                  </div>
                  <div className="flex items-center gap-2 bg-stone-100 rounded-xl px-2 py-1.5 flex-shrink-0">
                    <button onClick={() => changeQty(c.key, -1)} className="w-6 h-6 flex items-center justify-center text-stone-600 font-black text-base">−</button>
                    <span className="text-sm font-black w-5 text-center text-stone-800">{c.qty}</span>
                    <button onClick={() => changeQty(c.key, +1)} className="w-6 h-6 flex items-center justify-center text-orange-500 font-black text-base">+</button>
                  </div>
                </div>
              ))}
            </div>
            {/* Totals summary */}
            <div className="px-4 py-3 bg-stone-50 border-t border-stone-100 flex-shrink-0">
              <div className="flex justify-between text-xs text-stone-500 mb-1"><span>Subtotal</span><span>₹{subtotal}</span></div>
              {gstAmt > 0 && <div className="flex justify-between text-xs text-stone-500 mb-1"><span>GST ({gstPct}%)</span><span>₹{gstAmt}</span></div>}
              {packing > 0 && <div className="flex justify-between text-xs text-stone-500 mb-1"><span>Packing</span><span>₹{packing}</span></div>}
              <div className="flex justify-between font-black text-stone-900 text-base mt-1 pt-1 border-t border-stone-200">
                <span>Total</span><span className="text-orange-600">₹{grandTotal}</span>
              </div>
            </div>
            {/* Actions */}
            <div className="px-4 pb-6 pt-3 flex gap-2 flex-shrink-0">
              <button onClick={() => { setShowBill(false); }}
                className="flex-1 py-3.5 rounded-2xl bg-stone-100 text-stone-700 font-black text-sm active:scale-95 transition-all">
                + Add More
              </button>
              <button onClick={() => { setShowBill(false); setShowCheckout(true); }}
                className="flex-[2] py-3.5 rounded-2xl bg-gradient-to-r from-orange-500 to-red-500 text-white font-black text-sm shadow-lg active:scale-95 transition-all">
                Proceed to Checkout →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Checkout bottom sheet ── */}
      {showCheckout && (
        <div className="fixed inset-0 z-30 flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowCheckout(false)} />
          <div className="relative bg-white rounded-t-3xl max-h-[90vh] flex flex-col">
            <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
              <div className="w-10 h-1 bg-stone-300 rounded-full" />
            </div>
            <div className="px-4 py-2 flex items-center justify-between flex-shrink-0">
              <button onClick={() => { setShowCheckout(false); setShowBill(true); }} className="flex items-center gap-1 text-orange-500 font-bold text-sm">
                <ArrowLeft size={16} /> Bill
              </button>
              <span className="font-black text-stone-800 text-base">Checkout</span>
              <button onClick={() => setShowCheckout(false)} className="w-8 h-8 bg-stone-100 rounded-full flex items-center justify-center">
                <X size={16} className="text-stone-500" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 pb-2 space-y-4">
              {/* Customer details */}
              <div className="space-y-2 pt-2">
                <p className="text-xs font-black text-stone-500 uppercase tracking-widest">Customer Details</p>
                <input value={custName} onChange={e => setCustName(e.target.value)} placeholder="Customer name (optional)"
                  className="w-full text-sm border border-stone-200 rounded-xl px-4 py-3 outline-none focus:border-orange-400" />
                <input value={custPhone} onChange={e => setCustPhone(e.target.value.replace(/\D/g,"").slice(0,10))} placeholder="Phone (optional)" inputMode="numeric"
                  className="w-full text-sm border border-stone-200 rounded-xl px-4 py-3 outline-none focus:border-orange-400" />
                {orderType === "dine-in" && (
                  <input value={tableLabel} onChange={e => setTableLabel(e.target.value)} placeholder="Table number (optional)"
                    className="w-full text-sm border border-stone-200 rounded-xl px-4 py-3 outline-none focus:border-orange-400" />
                )}
              </div>
              {/* Discount */}
              <div className="space-y-2">
                <p className="text-xs font-black text-stone-500 uppercase tracking-widest">Discount</p>
                <input value={discount} onChange={e => setDiscount(e.target.value)} type="number" min="0" placeholder="₹ Discount amount"
                  className="w-full text-sm border border-stone-200 rounded-xl px-4 py-3 outline-none focus:border-orange-400" />
              </div>
              {/* Payment method */}
              <div className="space-y-2">
                <p className="text-xs font-black text-stone-500 uppercase tracking-widest">Payment</p>
                <div className="grid grid-cols-4 gap-2">
                  {["Cash","UPI","Card","Online"].map(m => (
                    <button key={m} onClick={() => setPayMethod(m)}
                      className={`py-3 rounded-xl text-sm font-black transition-all ${payMethod === m ? "bg-stone-800 text-white shadow-sm" : "bg-stone-100 text-stone-600"}`}>
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              {/* Note */}
              <div className="space-y-2">
                <p className="text-xs font-black text-stone-500 uppercase tracking-widest">Note</p>
                <input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. no onion, extra spicy"
                  className="w-full text-sm border border-stone-200 rounded-xl px-4 py-3 outline-none focus:border-orange-400" />
              </div>
              {/* Order summary */}
              <div className="bg-stone-50 rounded-2xl p-4 space-y-1.5">
                <p className="text-xs font-black text-stone-500 uppercase tracking-widest mb-2">Summary</p>
                <div className="flex justify-between text-xs text-stone-500"><span>Subtotal</span><span>₹{subtotal}</span></div>
                {discAmt > 0 && <div className="flex justify-between text-xs text-green-600"><span>Discount</span><span>−₹{discAmt}</span></div>}
                {gstAmt > 0 && <div className="flex justify-between text-xs text-stone-500"><span>GST ({gstPct}%)</span><span>₹{gstAmt}</span></div>}
                {packing > 0 && <div className="flex justify-between text-xs text-stone-500"><span>Packing</span><span>₹{packing}</span></div>}
                <div className="flex justify-between font-black text-stone-900 text-lg pt-2 border-t border-stone-200">
                  <span>Total</span><span className="text-orange-600">₹{grandTotal}</span>
                </div>
              </div>
              {printErr && (
                <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                  <p className="text-xs text-red-700">{printErr}</p>
                </div>
              )}
            </div>
            {/* Action buttons */}
            <div className="px-4 pb-6 pt-3 space-y-2 flex-shrink-0 border-t border-stone-100">
              <div className="flex gap-2">
                <button onClick={handlePrintKOT} disabled={placing}
                  className="flex-1 py-3.5 rounded-2xl bg-amber-500 text-white font-black text-sm shadow-sm disabled:opacity-50 active:scale-95 transition-all">
                  🍳 KOT
                </button>
                <button onClick={handleBillOnly} disabled={placing}
                  className="flex-1 py-3.5 rounded-2xl bg-blue-600 text-white font-black text-sm shadow-sm disabled:opacity-50 active:scale-95 transition-all">
                  🧾 Bill Only
                </button>
              </div>
              <button onClick={handleBill} disabled={placing}
                className="w-full py-4 rounded-2xl bg-gradient-to-r from-orange-500 to-red-500 text-white font-black text-base shadow-xl disabled:opacity-50 active:scale-[0.98] transition-all flex items-center justify-center gap-2">
                {placing
                  ? <><div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Billing…</>
                  : <><Printer size={16} /> KOT + Bill — ₹{grandTotal}</>}
              </button>
              {lastOrder && (
                <div className="flex gap-2">
                  <button onClick={() => { try { printKOT(lastOrder); toast.success("KOT reprinted"); } catch(e) { setPrintErr(e.message); }}}
                    className="flex-1 py-2.5 rounded-xl bg-stone-100 text-stone-600 text-xs font-bold active:scale-95 transition-all">
                    🍳 Reprint KOT
                  </button>
                  <button onClick={() => { try { printInvoice(lastOrder, bizSettings); toast.success("Reprinted ✓"); } catch(e) { setPrintErr(e.message); }}}
                    className="flex-1 py-2.5 rounded-xl bg-stone-100 text-stone-600 text-xs font-bold active:scale-95 transition-all">
                    🧾 Reprint Bill
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  TABLES GRID TAB
// ─────────────────────────────────────────────────────────
function TablesTab({ orders }) {
  const ACTIVE_TABLES = 8; // currently active tables; rest shown as coming soon
  // "served" is included here on purpose — a dine-in table that's been served
  // still has the guest sitting at it until staff explicitly hit
  // "Clear Table (Guest Left)", which moves the order to "completed" and
  // frees the table. Without this, the table showed "Free" the moment food
  // went out, even though nobody had actually left yet.
  const ACTIVE = ["pending", "accepted", "ready", "served"];
  const tableMap = {};
  orders.forEach(o => {
    if (o.order_type !== "dine-in" || !o.table_label) return;
    if (!ACTIVE.includes(o.status)) return;
    const lbl = o.table_label.trim();
    if (!tableMap[lbl]) tableMap[lbl] = [];
    tableMap[lbl].push(o);
  });

  const allTables = Object.values(TABLE_CODES).sort((a, b) => {
    const na = parseInt(a.replace(/\D/g, ""));
    const nb = parseInt(b.replace(/\D/g, ""));
    return na - nb;
  });

  const activeTables = allTables.slice(0, ACTIVE_TABLES);
  const futureTables = allTables.slice(ACTIVE_TABLES);
  const statusPriority = { pending: 0, accepted: 1, ready: 2, served: 3 };

  const renderTable = (label, future = false) => {
    const tableOrders = future ? [] : (tableMap[label] || []);
    const occupied = tableOrders.length > 0;
    const topStatus = occupied
      ? tableOrders.reduce((best, o) =>
          (statusPriority[o.status] ?? 99) < (statusPriority[best] ?? 99) ? o.status : best,
          tableOrders[0].status)
      : null;
    // At least one order at this table has been served but not yet cleared —
    // this is the "why is it still occupied" reason shown on the tile.
    const notEmptyYet = tableOrders.some(o => o.status === "served");
    const total = tableOrders.reduce((s, o) => s + (o.total || 0), 0);
    const cfg = topStatus ? STATUS_CFG[topStatus] : null;
    const numLabel = label.replace(/\D/g, "");

    if (future) {
      return (
        <div key={label} className="relative rounded-2xl border-2 border-dashed border-stone-200 p-3 flex flex-col items-center gap-1 opacity-35">
          <p className="text-2xl font-black text-stone-300">{numLabel}</p>
          <p className="text-[9px] font-bold text-stone-300 uppercase tracking-widest -mt-1">Table</p>
          <p className="text-[9px] text-stone-300 font-medium mt-1">Soon</p>
        </div>
      );
    }

    const bgClass = !occupied ? "bg-stone-100 border-stone-200"
      : topStatus === "pending"  ? "bg-blue-50 border-blue-300"
      : topStatus === "accepted" ? "bg-orange-50 border-orange-300"
      : topStatus === "ready"    ? "bg-green-50 border-green-300"
      : topStatus === "served"   ? "bg-amber-50 border-amber-300"
      : "bg-stone-100 border-stone-200";
    const dotClass = !occupied ? "bg-stone-300"
      : topStatus === "pending"  ? "bg-blue-400 animate-pulse"
      : topStatus === "accepted" ? "bg-orange-400 animate-pulse"
      : topStatus === "ready"    ? "bg-green-400"
      : topStatus === "served"   ? "bg-amber-400"
      : "bg-stone-300";

    return (
      <div key={label} className={`relative rounded-2xl border-2 p-3 flex flex-col items-center gap-1 transition-all ${bgClass}`}>
        <span className={`absolute top-2 right-2 w-2 h-2 rounded-full ${dotClass}`} />
        <p className="text-2xl font-black text-stone-700">{numLabel}</p>
        <p className="text-[9px] font-bold text-stone-400 uppercase tracking-widest -mt-1">Table</p>
        {occupied ? (
          <>
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full mt-0.5 ${cfg?.color || ""}`}>
              {topStatus === "served" ? "🍽️ At Table" : (cfg?.label || topStatus)}
            </span>
            <p className="text-xs font-black text-orange-600">₹{total}</p>
            <p className="text-[9px] text-stone-400">{tableOrders.length} order{tableOrders.length > 1 ? "s" : ""}</p>
            {notEmptyYet && (
              <p className="text-[8px] text-amber-600 font-bold text-center leading-tight mt-0.5">Table not empty yet</p>
            )}
          </>
        ) : (
          <p className="text-[10px] text-stone-400 font-medium mt-1">Free</p>
        )}
      </div>
    );
  };

  const occupiedCount = activeTables.filter(l => tableMap[l]).length;

  return (
    <div className="space-y-4">
      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-[10px] font-bold text-stone-500">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-stone-300 inline-block" /> Free</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-blue-400 inline-block" /> Order Placed</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-orange-400 inline-block" /> Preparing</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-green-400 inline-block" /> Ready</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" /> At Table (not cleared)</span>
      </div>

      {/* Active tables grid */}
      <div className="grid grid-cols-4 gap-3">
        {activeTables.map(label => renderTable(label, false))}
        {futureTables.map(label => renderTable(label, true))}
      </div>

      {/* Summary bar — active tables only */}
      <div className="bg-white rounded-2xl border border-stone-100 p-4 flex justify-around text-center">
        <div>
          <p className="text-xl font-black text-stone-800">{ACTIVE_TABLES}</p>
          <p className="text-[10px] text-stone-400 font-bold uppercase tracking-widest">Tables</p>
        </div>
        <div>
          <p className="text-xl font-black text-orange-500">{occupiedCount}</p>
          <p className="text-[10px] text-stone-400 font-bold uppercase tracking-widest">Occupied</p>
        </div>
        <div>
          <p className="text-xl font-black text-green-600">{ACTIVE_TABLES - occupiedCount}</p>
          <p className="text-[10px] text-stone-400 font-bold uppercase tracking-widest">Free</p>
        </div>
        <div>
          <p className="text-xl font-black text-stone-800">
            ₹{activeTables.flatMap(l => tableMap[l] || []).reduce((s, o) => s + (o.total || 0), 0)}
          </p>
          <p className="text-[10px] text-stone-400 font-bold uppercase tracking-widest">Active ₹</p>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  VARIANT BUILDER — replaces raw JSON textarea
// ─────────────────────────────────────────────────────────
const VARIANT_PRESETS = [
  { label: "Half / Full",        variants: [{ label: "Half", price: "" }, { label: "Full", price: "" }] },
  { label: "Regular / Large",    variants: [{ label: "Regular", price: "" }, { label: "Large", price: "" }] },
  { label: "Small / Med / Large",variants: [{ label: "Small", price: "" }, { label: "Medium", price: "" }, { label: "Large", price: "" }] },
  { label: "Tall / Full",        variants: [{ label: "Tall", price: "" }, { label: "Full", price: "" }] },
];

function VariantBuilder({ variants, onChange }) {
  const addRow    = () => onChange([...variants, { label: "", price: "" }]);
  const removeRow = (i) => onChange(variants.filter((_, x) => x !== i));
  const update    = (i, field, val) => onChange(variants.map((v, x) => x === i ? { ...v, [field]: val } : v));

  return (
    <div className="space-y-2">
      {variants.length === 0 && (
        <div>
          <p className="text-[10px] text-stone-400 mb-2">Quick-fill a common pattern:</p>
          <div className="flex gap-1.5 flex-wrap">
            {VARIANT_PRESETS.map(p => (
              <button key={p.label} type="button" onClick={() => onChange(p.variants.map(v => ({ ...v })))}
                className="text-[10px] font-bold bg-orange-50 text-orange-600 border border-orange-200 px-2.5 py-1 rounded-lg hover:bg-orange-100 transition-colors">
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {variants.map((v, i) => (
        <div key={i} className="flex gap-2 items-center">
          <input value={v.label} onChange={e => update(i, "label", e.target.value)}
            placeholder="e.g. Half, Full, Large…"
            className="flex-1 text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2 outline-none" />
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400 text-sm font-bold">₹</span>
            <input type="number" min="0" value={v.price} onChange={e => update(i, "price", e.target.value)}
              placeholder="0"
              className="w-24 text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl pl-7 pr-3 py-2 outline-none" />
          </div>
          <button type="button" onClick={() => removeRow(i)}
            className="w-8 h-8 flex items-center justify-center rounded-xl bg-red-50 text-red-400 hover:bg-red-100 flex-shrink-0 transition-colors">
            <Trash2 size={13} />
          </button>
        </div>
      ))}

      {variants.length > 0 && (
        <button type="button" onClick={addRow}
          className="w-full flex items-center justify-center gap-1.5 border-2 border-dashed border-orange-200 text-orange-500 text-xs font-bold py-2 rounded-xl hover:bg-orange-50 transition-colors">
          <Plus size={12} /> Add another size
        </button>
      )}

      {variants.length === 0 && (
        <button type="button" onClick={addRow}
          className="w-full flex items-center justify-center gap-1.5 border-2 border-dashed border-stone-200 text-stone-400 text-xs font-bold py-2 rounded-xl hover:border-orange-200 hover:text-orange-500 transition-colors">
          <Plus size={12} /> Add custom size
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  ADDON BUILDER — replaces raw JSON textarea
// ─────────────────────────────────────────────────────────
function AddonBuilder({ addons, onChange }) {
  const removeAddon   = (i) => onChange(addons.filter((_, x) => x !== i));
  const updateAddon   = (i, field, val) => onChange(addons.map((a, x) => x === i ? { ...a, [field]: val } : a));
  const updateOptions = (i, raw) => {
    const opts = raw.split(",").map(s => s.trim()).filter(Boolean);
    onChange(addons.map((a, x) => x === i ? { ...a, options: opts } : a));
  };

  const addToggle = () => onChange([...addons, {
    id: `addon_${Date.now()}`, label: "", type: "toggle", price: 0,
  }]);
  const addSelect = () => onChange([...addons, {
    id: `choice_${Date.now()}`, label: "Spice Level", type: "select",
    options: ["Mild", "Medium", "Extra Hot"], price: 0,
  }]);

  return (
    <div className="space-y-3">
      {addons.map((a, i) => (
        <div key={i} className="bg-stone-50 border-2 border-stone-100 rounded-xl p-3 space-y-2">
          {/* Label + delete */}
          <div className="flex gap-2 items-center">
            <span className="text-[10px] font-black text-stone-400 uppercase tracking-wider flex-shrink-0">Name</span>
            <input value={a.label} onChange={e => updateAddon(i, "label", e.target.value)}
              placeholder="e.g. Extra Cheese, Spice Level…"
              className="flex-1 text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2 outline-none bg-white" />
            <button type="button" onClick={() => removeAddon(i)}
              className="w-8 h-8 flex items-center justify-center rounded-xl bg-red-50 text-red-400 hover:bg-red-100 flex-shrink-0 transition-colors">
              <Trash2 size={13} />
            </button>
          </div>

          {/* Type row */}
          <div className="flex gap-2 items-center flex-wrap">
            <select value={a.type} onChange={e => updateAddon(i, "type", e.target.value)}
              className="text-xs border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-1.5 outline-none bg-white font-bold text-stone-700">
              <option value="toggle">☑️ Checkbox (yes / no)</option>
              <option value="select">🔘 Choice from a list</option>
            </select>

            {a.type === "toggle" && (
              <div className="flex items-center gap-1.5 bg-white border-2 border-stone-200 rounded-xl px-3 py-1.5">
                <span className="text-xs text-stone-400 font-bold">Extra charge</span>
                <span className="text-xs text-stone-400">+₹</span>
                <input type="number" min="0" value={a.price ?? 0} onChange={e => updateAddon(i, "price", Number(e.target.value))}
                  className="w-16 text-sm font-bold text-stone-700 bg-transparent outline-none" />
              </div>
            )}
          </div>

          {/* Select options */}
          {a.type === "select" && (
            <div>
              <p className="text-[10px] text-stone-400 font-bold mb-1">Choices <span className="font-normal">(separate with commas)</span></p>
              <input value={(a.options || []).join(", ")} onChange={e => updateOptions(i, e.target.value)}
                placeholder="e.g. Mild, Medium, Extra Hot"
                className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2 outline-none bg-white" />
              <div className="flex gap-1 mt-1.5 flex-wrap">
                {(a.options || []).map((opt, j) => (
                  <span key={j} className="text-[10px] bg-white border border-stone-200 text-stone-600 px-2 py-0.5 rounded-full">{opt}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}

      <div className="flex gap-2">
        <button type="button" onClick={addToggle}
          className="flex-1 flex items-center justify-center gap-1.5 border-2 border-dashed border-orange-200 text-orange-500 text-xs font-bold py-2.5 rounded-xl hover:bg-orange-50 transition-colors">
          <Plus size={12} /> Add Checkbox
        </button>
        <button type="button" onClick={addSelect}
          className="flex-1 flex items-center justify-center gap-1.5 border-2 border-dashed border-blue-200 text-blue-500 text-xs font-bold py-2.5 rounded-xl hover:bg-blue-50 transition-colors">
          <Plus size={12} /> Add Choice List
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  MENU MANAGEMENT TAB
// ─────────────────────────────────────────────────────────
// ── Image compression helper ─────────────────────────────
// Smart multi-pass compressor — targets ~30KB max for menu thumbnails.
// Pass 1: resize to 320px wide at 55% quality.
// Pass 2: if still >40KB, drop to 240px at 45% quality.
// Pass 3: if still >30KB, drop quality to 35% (keeps dimensions).
// This typically brings a 300-500KB food photo down to 15-35KB.
function compressImage(file, maxWidth = 320, quality = 0.55) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = async () => {
      URL.revokeObjectURL(url);

      const drawToBlob = (w, h, q) => new Promise((res, rej) => {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        canvas.toBlob(b => b ? res(b) : rej(new Error("toBlob failed")), "image/jpeg", q);
      });

      try {
        // Pass 1 — 320px, 55%
        let scale = Math.min(1, maxWidth / img.width);
        let w = Math.round(img.width * scale);
        let h = Math.round(img.height * scale);
        let blob = await drawToBlob(w, h, quality);

        // Pass 2 — still >40KB? drop to 240px, 45%
        if (blob.size > 40 * 1024) {
          scale = Math.min(1, 240 / img.width);
          w = Math.round(img.width * scale);
          h = Math.round(img.height * scale);
          blob = await drawToBlob(w, h, 0.45);
        }

        // Pass 3 — still >30KB? drop quality to 35%, keep dimensions
        if (blob.size > 30 * 1024) {
          blob = await drawToBlob(w, h, 0.35);
        }

        resolve(blob);
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image load failed")); };
    img.src = url;
  });
}

// Like compressImage but takes a raw Blob — uses window.Image and window.URL
// explicitly so Vite's minifier cannot rename them.
function compressBlob(blob, maxWidth = 320, quality = 0.55) {
  return new Promise((resolve, reject) => {
    const objUrl = window.URL.createObjectURL(blob);
    const img = new window.Image();
    img.onload = async () => {
      window.URL.revokeObjectURL(objUrl);
      const drawToBlob = (w, h, q) => new Promise((res, rej) => {
        const canvas = window.document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        canvas.toBlob(b => b ? res(b) : rej(new Error("toBlob failed")), "image/jpeg", q);
      });
      try {
        let scale = Math.min(1, maxWidth / img.width);
        let w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        let result = await drawToBlob(w, h, quality);
        if (result.size > 40 * 1024) {
          scale = Math.min(1, 240 / img.width);
          w = Math.round(img.width * scale); h = Math.round(img.height * scale);
          result = await drawToBlob(w, h, 0.45);
        }
        if (result.size > 30 * 1024) result = await drawToBlob(w, h, 0.35);
        resolve(result);
      } catch (e) { reject(e); }
    };
    img.onerror = () => { window.URL.revokeObjectURL(objUrl); reject(new Error("Image load failed")); };
    img.src = objUrl;
  });
}

function MenuTab() {
  const toast = useToast();
  const [dbCats, setDbCats] = useState([]);
  const [items,   setItems]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null); // item being edited

  // Form state — variants/addons are structured arrays now, no raw JSON
  const blankForm = { name: "", category: "burgers", price: "", img_url: "", description: "", variants: [], addons: [], is_available: true };
  const [form, setForm] = useState(blankForm);
  const [saving, setSaving]       = useState(false);
  const [formErr, setFormErr]     = useState("");
  const [uploadingImg, setUploadingImg] = useState(false);
  const imgInputRef = useRef(null);

  const handleImgUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // JPG only
    const isJpg = file.type === "image/jpeg" || file.name.toLowerCase().endsWith(".jpg") || file.name.toLowerCase().endsWith(".jpeg");
    if (!isJpg) {
      setFormErr("Only JPG/JPEG images are allowed.");
      if (imgInputRef.current) imgInputRef.current.value = "";
      return;
    }

    if (!SUPABASE_READY) {
      setFormErr("Storage not configured. Please set up Supabase environment variables.");
      return;
    }

    setUploadingImg(true);
    setFormErr("");
    // Compress before upload: resize to max 400px wide, 65% JPEG quality
    let uploadFile = file;
    try { uploadFile = await compressImage(file); } catch { /* fall back to original if compression fails */ }
    // Fix: strip existing extension before building filename to avoid double-extension (e.g. photo.jpg.jpg)
    const baseName = file.name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9]/gi, "_");
    const fileName = `menu/${Date.now()}_${baseName}.jpg`;
    const { data, error } = await supabase.storage
      .from("menu-images")
      .upload(fileName, uploadFile, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });

    if (error) {
      setFormErr(`Upload failed: ${error.message}`);
    } else {
      const { data: { publicUrl } } = supabase.storage.from("menu-images").getPublicUrl(data.path);
      setForm(f => ({ ...f, img_url: publicUrl }));
    }
    setUploadingImg(false);
    // Use ref instead of e.target (which goes stale after await due to React re-renders)
    if (imgInputRef.current) imgInputRef.current.value = "";
  };

  const loadItems = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from("menu_items").select("*").order("category").order("name");
    setLoading(false);
    if (data) setItems(data);
  }, []);

  useEffect(() => { if (SUPABASE_READY) loadItems(); }, [loadItems]);

  useEffect(() => {
    if (!SUPABASE_READY) return;
    supabase.from("categories").select("*").order("sort_order")
      .then(({ data }) => { if (data?.length) setDbCats(data); });
  }, []);

  const openAdd = () => { setForm(blankForm); setEditing(null); setFormErr(""); setShowForm(true); };
  const openEdit = (item) => {
    // Parse existing variants/addons into structured arrays; fall back gracefully
    let variants = [];
    let addons   = [];
    try { if (item.variants?.length) variants = item.variants.map(v => ({ label: v.label || "", price: String(v.price ?? "") })); } catch {}
    try { if (item.addons?.length)   addons   = item.addons; } catch {}
    setForm({
      name: item.name, category: item.category, price: String(item.price),
      img_url: item.img || item.img_url || "",
      description: item.description || "",
      variants,
      addons,
      is_available: item.is_available !== false,
    });
    setEditing(item.id); setFormErr(""); setShowForm(true);
  };

  const saveItem = async () => {
    if (!form.name.trim())          { setFormErr("Name is required."); return; }
    if (!form.price || isNaN(Number(form.price))) { setFormErr("Valid price required."); return; }

    // Build variants array from builder rows; skip empty rows
    const variants = form.variants.length
      ? form.variants.filter(v => v.label.trim()).map(v => ({ label: v.label.trim(), price: Number(v.price) || 0 }))
      : null;
    const addons = form.addons || [];

    setSaving(true);
    const payload = {
      name: form.name.trim(), category: form.category, price: Number(form.price),
      img: form.img_url.trim() || null, description: form.description.trim(),
      variants, addons, is_available: form.is_available,
    };

    if (editing) {
      const { error } = await supabase.from("menu_items").update(payload).eq("id", editing);
      setSaving(false);
      if (error) { toast.error("⚠️ Save failed — " + error.message); return; }
    } else {
      const { error } = await supabase.from("menu_items").insert({ ...payload, id: `custom_${Date.now()}` });
      setSaving(false);
      if (error) { toast.error("⚠️ Add failed — " + error.message); return; }
    }
    setShowForm(false); loadItems();
  };

  const [pendingDelete, setPendingDelete] = useState(null);
  const deleteItem = async (id) => {
    if (pendingDelete !== id) { setPendingDelete(id); setTimeout(() => setPendingDelete(null), 3000); return; }
    setPendingDelete(null);
    const { error } = await supabase.from("menu_items").delete().eq("id", id);
    if (error) { toast.error("⚠️ Delete failed — " + error.message); return; }
    loadItems();
  };

  const toggleAvail = async (id, current) => {
    setItems(prev => prev.map(i => i.id === id ? { ...i, is_available: !current } : i));
    const { error } = await supabase.from("menu_items").update({ is_available: !current }).eq("id", id);
    if (error) {
      setItems(prev => prev.map(i => i.id === id ? { ...i, is_available: current } : i));
      toast.error("⚠️ Couldn't update availability — " + error.message);
    }
  };

  const toggleBestseller = async (id, current) => {
    const next = current ? null : true;
    setItems(prev => prev.map(i => i.id === id ? { ...i, is_bestseller_manual: next } : i));
    const { error } = await supabase.from("menu_items").update({ is_bestseller_manual: next }).eq("id", id);
    if (error) {
      setItems(prev => prev.map(i => i.id === id ? { ...i, is_bestseller_manual: current } : i));
      toast.error("⚠️ Couldn't update bestseller — " + error.message);
      return;
    }
    localStorage.removeItem("bp_bestsellers");
  };

  // Group items by category
  const grouped = {};
  items.forEach(item => {
    if (!grouped[item.category]) grouped[item.category] = [];
    grouped[item.category].push(item);
  });

  if (loading) return (
    <div className="space-y-2 pt-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="bg-white rounded-2xl border border-stone-100 p-3 flex items-center gap-3">
          <div className="relative overflow-hidden bg-stone-100 rounded-xl w-12 h-12 flex-shrink-0">
            <div className="shimmer-wave absolute inset-0" />
          </div>
          <div className="flex-1 space-y-2">
            <div className="relative overflow-hidden bg-stone-100 rounded h-3 w-2/3"><div className="shimmer-wave absolute inset-0" /></div>
            <div className="relative overflow-hidden bg-stone-100 rounded h-3 w-1/3"><div className="shimmer-wave absolute inset-0" /></div>
          </div>
          <div className="relative overflow-hidden bg-stone-100 rounded-xl w-16 h-7"><div className="shimmer-wave absolute inset-0" /></div>
        </div>
      ))}
    </div>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="font-bold text-stone-800">Menu Items</p>
          <p className="text-xs text-stone-400">{items.length} items · managed from Supabase</p>
        </div>
        <button onClick={openAdd} className="flex items-center gap-1.5 bg-orange-500 text-white text-xs font-bold px-4 py-2.5 rounded-xl shadow-sm active:scale-95 transition-transform">
          <Plus size={13} /> Add Item
        </button>
      </div>

      {items.length === 0 ? (
        <div className="text-center py-12 bg-stone-50 rounded-2xl border-2 border-dashed border-stone-200">
          <p className="text-3xl mb-2">🍔</p>
          <p className="text-sm font-bold text-stone-600 mb-1">No items in Supabase yet</p>
          <p className="text-xs text-stone-400 mb-4">Add items here or they'll load from the built-in default menu.</p>
          <button onClick={openAdd} className="bg-orange-500 text-white text-xs font-bold px-4 py-2 rounded-xl">Add First Item</button>
        </div>
      ) : (
        Object.entries(grouped).map(([cat, catItems]) => {
          const catData = CATEGORIES.find(c => c.id === cat) || dbCats.find(c => c.id === cat);
          return (
            <div key={cat} className="mb-5">
              <p className="text-xs font-bold text-stone-500 uppercase tracking-widest mb-2">{catData?.emoji} {catData?.label || cat}</p>
              <div className="space-y-2">
                {catItems.map(item => (
                  <div key={item.id} className={`bg-white border rounded-xl px-4 py-3 flex items-center gap-3 ${item.is_available === false ? "opacity-60 border-stone-100" : "border-stone-100"}`}>
                    {item.img && <img src={item.img} alt={item.name} className="w-10 h-10 rounded-lg object-cover flex-shrink-0" onError={e => e.target.style.display = "none"} />}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="text-sm font-bold text-stone-800 truncate">{item.name}</p>
                        {item.is_bestseller_manual && <span className="text-[9px] font-black bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded-full flex-shrink-0">🔥 Bestseller</span>}
                      </div>
                      <p className="text-xs text-stone-400">₹{item.price}{item.variants ? " onwards" : ""}{item.addons?.length ? " · customisable" : ""}</p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {/* Bestseller pin */}
                      <button onClick={() => toggleBestseller(item.id, item.is_bestseller_manual)}
                        title={item.is_bestseller_manual ? "Unpin Bestseller" : "Pin as Bestseller"}
                        className={`text-xs font-bold px-2 py-1 rounded-lg transition-all ${item.is_bestseller_manual ? "bg-orange-100 text-orange-600" : "bg-stone-100 text-stone-400"}`}>
                        🔥
                      </button>
                      {/* Availability toggle */}
                      <button onClick={() => toggleAvail(item.id, item.is_available !== false)} title={item.is_available !== false ? "Mark Sold Out" : "Mark Available"}
                        className={`text-xs font-bold px-2.5 py-1 rounded-lg transition-all ${item.is_available !== false ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"}`}>
                        {item.is_available !== false ? "Avail" : "Out"}
                      </button>
                      <button onClick={() => openEdit(item)} className="w-7 h-7 rounded-lg bg-stone-100 flex items-center justify-center"><Edit2 size={12} className="text-stone-500" /></button>
                      <button onClick={() => deleteItem(item.id)}
                        className={`h-7 rounded-lg flex items-center justify-center px-2 transition-all ${pendingDelete === item.id ? "bg-red-500 text-white text-[10px] font-bold px-2" : "w-7 bg-red-50"}`}>
                        {pendingDelete === item.id ? "Sure?" : <Trash2 size={12} className="text-red-400" />}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })
      )}

      {/* Add / Edit Form Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/60 backdrop-blur-sm" onClick={() => setShowForm(false)}>
          <div className="w-full bg-white rounded-t-3xl max-w-xl mx-auto flex flex-col" style={{ maxHeight: "90vh" }} onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 bg-stone-200 rounded-full mx-auto mt-3 flex-shrink-0" />
            <div className="flex items-center justify-between px-5 pt-3 pb-3 border-b border-stone-100 flex-shrink-0">
              <h3 className="font-bold text-stone-800">{editing ? "Edit Item" : "Add New Item"}</h3>
              <button onClick={() => setShowForm(false)}><X size={18} className="text-stone-400" /></button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {/* Name */}
              <div>
                <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Item Name *</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Paneer Tikki Burger"
                  className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-4 py-3 outline-none text-stone-700" />
              </div>
              {/* Category + Price */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Category</label>
                  <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                    className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-3 outline-none text-stone-700">
                    {(dbCats.length ? dbCats : CATEGORIES).map(c => <option key={c.id} value={c.id}>{c.emoji} {c.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Base Price (₹) *</label>
                  <input type="number" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} placeholder="99"
                    className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-4 py-3 outline-none text-stone-700" />
                </div>
              </div>
              {/* Photo Upload */}
              <div>
                <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1 flex items-center gap-1"><Image size={9} /> Photo <span className="normal-case font-normal text-stone-400">(JPG only)</span></label>
                {/* File picker */}
                <label className={`flex items-center gap-2 w-full border-2 border-dashed rounded-xl px-4 py-3 cursor-pointer transition-colors ${uploadingImg ? "border-orange-300 bg-orange-50" : "border-stone-200 hover:border-orange-400 bg-white"}`}>
                  <Image size={14} className="text-stone-400 flex-shrink-0" />
                  <span className="text-sm text-stone-500 flex-1">
                    {uploadingImg ? "Uploading…" : "Click to upload JPG"}
                  </span>
                  <input
                    ref={imgInputRef}
                    type="file"
                    accept=".jpg,.jpeg,image/jpeg"
                    className="hidden"
                    disabled={uploadingImg}
                    onChange={handleImgUpload}
                  />
                </label>
                {/* URL fallback */}
                <p className="text-[10px] text-stone-400 mt-1 mb-1">Or paste a URL directly:</p>
                <input
                  value={form.img_url}
                  onChange={e => setForm(f => ({ ...f, img_url: e.target.value }))}
                  placeholder="https://…"
                  className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-4 py-3 outline-none text-stone-700"
                />
                {form.img_url && (
                  <div className="mt-2 relative">
                    <img src={form.img_url} alt="preview" className="h-24 w-full object-cover rounded-xl" onError={e => e.target.style.display = "none"} />
                    <button
                      type="button"
                      onClick={() => setForm(f => ({ ...f, img_url: "" }))}
                      className="absolute top-1 right-1 bg-black/50 text-white rounded-full p-0.5 hover:bg-black/70"
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}
              </div>
              {/* Description */}
              <div>
                <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Description</label>
                <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Short description shown under item name…"
                  className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-4 py-3 outline-none text-stone-700 resize-none h-16" />
              </div>
              {/* Variants */}
              <div>
                <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-2">
                  Size Variants <span className="normal-case font-normal text-stone-300">(optional — Half/Full, Reg/Large, etc.)</span>
                </label>
                <VariantBuilder
                  variants={form.variants}
                  onChange={v => setForm(f => ({ ...f, variants: v }))}
                />
                {form.variants.length > 0 && (
                  <p className="text-[10px] text-stone-400 mt-1.5">
                    The base price above is the default. Each size overrides it when selected.
                  </p>
                )}
              </div>

              {/* Addons */}
              <div>
                <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-2">
                  Add-ons / Customisations <span className="normal-case font-normal text-stone-300">(optional)</span>
                </label>
                <AddonBuilder
                  addons={form.addons}
                  onChange={a => setForm(f => ({ ...f, addons: a }))}
                />
              </div>
              {/* Availability */}
              <div className="flex items-center justify-between bg-stone-50 rounded-xl px-4 py-3">
                <div>
                  <p className="text-sm font-bold text-stone-700">Available on Menu</p>
                  <p className="text-xs text-stone-400">Uncheck to mark as sold out</p>
                </div>
                <button onClick={() => setForm(f => ({ ...f, is_available: !f.is_available }))}
                  className={`w-12 h-6 rounded-full transition-all ${form.is_available ? "bg-green-500" : "bg-stone-300"} relative`}>
                  <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${form.is_available ? "right-0.5" : "left-0.5"}`} />
                </button>
              </div>

              {formErr && <p className="text-red-500 text-xs text-center">{formErr}</p>}
            </div>

            <div className="px-5 pb-6 pt-3 border-t border-stone-100 flex-shrink-0">
              <button onClick={saveItem} disabled={saving}
                className="w-full bg-gradient-to-r from-orange-500 to-red-500 text-white py-4 rounded-2xl font-bold text-sm shadow-md active:scale-95 transition-transform disabled:opacity-60 flex items-center justify-center gap-2">
                <Save size={15} /> {saving ? "Saving…" : editing ? "Save Changes" : "Add to Menu"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  SALES TAB
// ─────────────────────────────────────────────────────────
function SalesHistoryCard({ o }) {
  const [open, setOpen] = useState(false);
  const { settings: bizSettings } = useBusinessSettings();
  const toast = useToast();

  const handlePrint = async () => {
    try {
      await printInvoice(o, bizSettings);
      toast.success("Print dialog opened ✓");
    } catch (e) {
      toast.error(e.message || "Print failed");
    }
  };

  return (
    <div className={`rounded-xl border ${o.status === "cancelled" ? "border-red-100 bg-red-50" : "border-stone-100 bg-stone-50"}`}>
      {/* Summary row */}
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="text-base">{o.status === "cancelled" ? "✕" : "😊"}</span>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold text-stone-800 truncate">{o.table_label || o.customer_name || "Order"}</p>
          <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
            <p className="text-[10px] text-stone-400">
              {new Date(o.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
              {o.status === "cancelled" && o.cancel_reason && <span className="text-red-500"> · {o.cancel_reason}</span>}
            </p>
            {(() => {
              const pm = (o.payment_method || "").toLowerCase();
              const isOnline = pm.includes("razorpay") || pm.includes("online") || pm.includes("upi");
              return (
                <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold leading-none
                  ${isOnline ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"}`}>
                  {isOnline ? "💳 Razorpay" : "💵 Cash"}
                </span>
              );
            })()}
          </div>
        </div>
        <span className={`text-xs font-black flex-shrink-0 mr-2 ${o.status === "cancelled" ? "text-red-500 line-through" : "text-orange-600"}`}>{currency(o.total)}</span>
        <button onClick={() => setOpen(v => !v)} className="w-6 h-6 flex items-center justify-center text-stone-400 hover:text-stone-600 flex-shrink-0">
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {/* Expanded: items + print */}
      {open && (
        <div className="px-3 pb-3 border-t border-stone-200/70 pt-2.5 space-y-1">
          {(o.items || []).map((it, i) => (
            <div key={i} className="flex justify-between text-xs">
              <span className="text-stone-700">
                {it.name}{it.selectedVariant ? ` (${it.selectedVariant})` : ""} ×{it.qty}
                {it.addonLabels?.length > 0 && <span className="text-orange-400"> ({it.addonLabels.join(", ")})</span>}
              </span>
              <span className="text-stone-500 font-semibold ml-2 flex-shrink-0">₹{it.finalPrice * it.qty}</span>
            </div>
          ))}
          {o.note && <p className="text-[11px] text-stone-400 italic pt-1">Note: "{o.note}"</p>}
          {o.promo_code && (
            <div className="flex justify-between text-xs pt-0.5">
              <span className="text-green-600 font-bold">🏷️ {o.promo_code}</span>
              <span className="text-green-600 font-bold">−{currency(o.discount)}</span>
            </div>
          )}
          <div className="flex justify-between text-xs font-black pt-1 border-t border-stone-200/70 mt-1">
            <span className="text-stone-700">Total</span>
            <span className="text-orange-600">₹{o.total}</span>
          </div>
          {o.status !== "cancelled" && (
            <button onClick={handlePrint}
              className="mt-2 w-full flex items-center justify-center gap-1.5 bg-orange-500 text-white text-xs font-bold py-2 rounded-xl active:scale-95 transition-transform shadow-sm">
              <Printer size={12} /> Print Bill
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SalesTab() {
  const [orders,  setOrders]  = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!SUPABASE_READY) { setLoading(false); return; }
    // Fetch last 30 days — enough for the 7-day chart + recent history
    const since = new Date();
    since.setDate(since.getDate() - 30);
    since.setHours(0, 0, 0, 0);
    supabase
      .from("orders")
      .select("id,created_at,status,order_type,total,payment_method,table_label,customer_name,items,cancel_reason")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .then(({ data }) => { if (data) setOrders(data); setLoading(false); });
  }, []);

  if (loading && orders.length === 0) return <SalesSkeleton />;
  const revenueOrders = orders.filter(o => o.status !== "cancelled");
  const today = new Date();
  const days  = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today); d.setDate(today.getDate() - (6 - i));
    return d.toISOString().split("T")[0];
  });

  const byDay = {};
  days.forEach(d => { byDay[d] = { revenue: 0, count: 0 }; });
  revenueOrders.forEach(o => {
    const d = (o.created_at || "").slice(0, 10);
    if (byDay[d]) { byDay[d].revenue += Number(o.total || 0); byDay[d].count += 1; }
  });

  const maxRev   = Math.max(...Object.values(byDay).map(d => d.revenue), 1);
  const todayStr = today.toISOString().split("T")[0];
  const todayData = byDay[todayStr] || { revenue: 0, count: 0 };

  const totalRev  = revenueOrders.reduce((s, o) => s + Number(o.total || 0), 0);
  const totalOrds = revenueOrders.length;
  const avgOrder  = totalOrds > 0 ? Math.round(totalRev / totalOrds) : 0;

  const typeBreak = { "dine-in": 0, takeaway: 0, delivery: 0 };
  revenueOrders.forEach(o => { typeBreak[o.order_type || "dine-in"] = (typeBreak[o.order_type || "dine-in"] || 0) + 1; });

  // History — completed and cancelled orders, most recent first. This is where
  // orders land once they leave the active Orders tab. "served" here only
  // covers delivery (its terminal state); dine-in/takeaway land as "completed".
  const history = orders
    .filter(o => o.status === "served" || o.status === "completed" || o.status === "cancelled")
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 40);

  return (
    <div className="space-y-5">
      {/* KPI cards */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Today", val: currency(todayData.revenue), sub: `${todayData.count} orders` },
          { label: "All Time", val: currency(totalRev), sub: `${totalOrds} orders` },
          { label: "Avg Order", val: currency(avgOrder), sub: "per order" },
        ].map(k => (
          <div key={k.label} className="bg-white border border-stone-100 rounded-2xl p-3 text-center shadow-sm">
            <p className="text-[10px] text-stone-400 font-bold uppercase tracking-widest">{k.label}</p>
            <p className="text-lg font-black text-stone-800 mt-1">{k.val}</p>
            <p className="text-[10px] text-stone-400">{k.sub}</p>
          </div>
        ))}
      </div>

      {/* 7-day bar chart */}
      <div className="bg-white border border-stone-100 rounded-2xl p-4 shadow-sm">
        <p className="text-xs font-bold text-stone-600 mb-4 flex items-center gap-1.5"><BarChart2 size={13} className="text-orange-400" /> Last 7 Days Revenue</p>
        <div className="flex items-end gap-2 h-32">
          {days.map(d => {
            const pct = byDay[d].revenue / maxRev;
            const isToday = d === todayStr;
            const label = new Date(d + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short" });
            return (
              <div key={d} className="flex-1 flex flex-col items-center gap-1">
                <p className="text-[9px] text-stone-500 font-bold">{byDay[d].revenue > 0 ? `₹${Math.round(byDay[d].revenue / 100) * 100 < 1000 ? byDay[d].revenue : `${(byDay[d].revenue / 1000).toFixed(1)}k`}` : ""}</p>
                <div className="w-full rounded-t-lg transition-all" style={{ height: `${Math.max(pct * 88, byDay[d].revenue > 0 ? 8 : 2)}px`, background: isToday ? "linear-gradient(to top,#f97316,#ef4444)" : "#e5e7eb" }} />
                <p className={`text-[9px] font-bold ${isToday ? "text-orange-500" : "text-stone-400"}`}>{label}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Order type breakdown */}
      <div className="bg-white border border-stone-100 rounded-2xl p-4 shadow-sm">
        <p className="text-xs font-bold text-stone-600 mb-3">Order Type Breakdown</p>
        {[
          { label: "Dine-In", emoji: "🍽️", count: typeBreak["dine-in"] },
          { label: "Takeaway", emoji: "📦", count: typeBreak["takeaway"] },
          { label: "Delivery", emoji: "🛵", count: typeBreak["delivery"] },
        ].map(t => (
          <div key={t.label} className="flex items-center gap-3 py-2">
            <span className="text-base">{t.emoji}</span>
            <div className="flex-1">
              <div className="flex justify-between mb-1">
                <span className="text-xs font-bold text-stone-700">{t.label}</span>
                <span className="text-xs text-stone-400">{t.count} orders</span>
              </div>
              <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-orange-400 to-red-400 rounded-full"
                  style={{ width: totalOrds > 0 ? `${(t.count / totalOrds) * 100}%` : "0%" }} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Payment methods */}
      <div className="bg-white border border-stone-100 rounded-2xl p-4 shadow-sm">
        <p className="text-xs font-bold text-stone-600 mb-3">Payment Methods</p>
        {(() => {
          const pm = {};
          revenueOrders.forEach(o => { pm[o.payment_method || "Cash"] = (pm[o.payment_method || "Cash"] || 0) + 1; });
          return Object.entries(pm).sort((a, b) => b[1] - a[1]).map(([method, count]) => (
            <div key={method} className="flex items-center justify-between py-1.5">
              <span className="text-sm text-stone-600">{method}</span>
              <span className="text-xs font-bold text-stone-700 bg-stone-100 px-2 py-0.5 rounded-lg">{count}</span>
            </div>
          ));
        })()}
      </div>

      {/* Order history — completed & cancelled orders live here once resolved */}
      <div className="bg-white border border-stone-100 rounded-2xl p-4 shadow-sm">
        <p className="text-xs font-bold text-stone-600 mb-3">Order History</p>
        {history.length === 0 ? (
          <p className="text-xs text-stone-400 text-center py-4">No completed or cancelled orders yet</p>
        ) : (
          <div className="space-y-2">
            {history.map(o => <SalesHistoryCard key={o.id} o={o} />)}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  CUSTOMERS TAB
// ─────────────────────────────────────────────────────────
function CustomersTab() {
  const [orders,  setOrders]  = useState([]);
  const [loading, setLoading] = useState(true);
  const [search,  setSearch]  = useState("");

  useEffect(() => {
    if (!SUPABASE_READY) { setLoading(false); return; }
    supabase
      .from("orders")
      .select("customer_phone,customer_name,total,created_at")
      .not("customer_phone", "is", null)
      .order("created_at", { ascending: false })
      .then(({ data }) => { if (data) setOrders(data); setLoading(false); });
  }, []);

  if (loading && orders.length === 0) return (
    <div className="space-y-2 pt-2">
      {Array.from({ length: 6 }).map((_, i) => <CustomerRowSkeleton key={i} />)}
    </div>
  );

  const customers = (() => {
    const map = {};
    orders.forEach(o => {
      const phone = o.customer_phone;
      if (!phone) return;
      if (!map[phone]) map[phone] = { name: o.customer_name || "Customer", phone, orders: 0, spent: 0, lastOrder: o.created_at };
      map[phone].orders += 1;
      map[phone].spent  += Number(o.total || 0);
      if (o.created_at > map[phone].lastOrder) { map[phone].lastOrder = o.created_at; map[phone].name = o.customer_name || map[phone].name; }
    });
    return Object.values(map).sort((a, b) => b.spent - a.spent);
  })();

  const filtered = search
    ? customers.filter(c => c.name.toLowerCase().includes(search.toLowerCase()) || c.phone.includes(search))
    : customers;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="font-bold text-stone-800">Customer Phone Book</p>
          <p className="text-xs text-stone-400">{customers.length} unique customers</p>
        </div>
      </div>
      <div className="flex items-center gap-2 bg-stone-100 rounded-xl px-3 py-2.5 mb-4">
        <Users size={13} className="text-stone-400" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or phone…"
          className="flex-1 text-sm bg-transparent outline-none text-stone-700 placeholder-stone-400" />
        {search && <button onClick={() => setSearch("")}><X size={12} className="text-stone-400" /></button>}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-12"><p className="text-3xl mb-2">👥</p><p className="text-sm text-stone-400">No customers yet</p></div>
      ) : (
        <div className="space-y-2">
          {filtered.map((c, i) => (
            <div key={c.phone} className="bg-white border border-stone-100 rounded-xl px-4 py-3 flex items-center gap-3">
              <div className="w-9 h-9 bg-gradient-to-br from-orange-100 to-amber-100 rounded-full flex items-center justify-center text-sm font-black text-orange-600 flex-shrink-0">
                {c.name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-stone-800 truncate">{c.name}</p>
                <p className="text-xs text-stone-400">{c.phone} · {c.orders} order{c.orders !== 1 ? "s" : ""} · {currency(c.spent)}</p>
              </div>
              <a href={`tel:${c.phone}`} className="w-8 h-8 rounded-xl bg-green-50 border border-green-200 flex items-center justify-center flex-shrink-0">
                <Phone size={13} className="text-green-600" />
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  BUSINESS SETTINGS (Phase 2)
// ─────────────────────────────────────────────────────────
function BusinessSettingsSection() {
  const { settings, loading, save } = useBusinessSettings();
  const [form, setForm]       = useState(settings);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const initialised           = useRef(false);
  const toast                 = useToast();

  // Only sync form from settings once — on initial load — so typing in an
  // input never causes a re-sync that blurs / resets the field mid-keystroke.
  useEffect(() => {
    if (!loading && !initialised.current) {
      setForm(settings);
      initialised.current = true;
    }
  }, [loading, settings]);

  const set = (k) => (e) => {
    const v = e?.target ? (e.target.type === "checkbox" ? e.target.checked : e.target.value) : e;
    setForm(f => ({ ...f, [k]: v }));
  };
  const numSet = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value === "" ? "" : Number(e.target.value) }));

  const doSave = async () => {
    setSaving(true); setSaved(false);
    const { error } = await save(form);
    setSaving(false);
    if (!error) { setSaved(true); toast.success("Settings saved!"); setTimeout(() => setSaved(false), 2000); }
    else toast.error("Save failed: " + error.message);
  };

  // Isolated single-field save (e.g. Logo URL) — smaller surface for debugging
  const [savingField, setSavingField] = useState(null);
  const [savedField,  setSavedField]  = useState(null);
  const saveOne = async (key) => {
    setSavingField(key);
    const { error } = await save({ [key]: form[key] });
    setSavingField(null);
    if (!error) { setSavedField(key); toast.success("Saved!"); setTimeout(() => setSavedField(null), 2000); }
    else toast.error(`Save failed: ${error.message}`);
  };

  const Field = ({ label, children }) => (
    <div>
      <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">{label}</label>
      {children}
    </div>
  );
  const inputCls = "w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2.5 outline-none text-stone-700";

  if (loading) return <Section emoji="🏪" title="Business Settings"><p className="text-xs text-stone-400">Loading…</p></Section>;

  return (
    <Section emoji="🏪" title="Business Settings">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Restaurant Name"><input value={form.restaurant_name || ""} onChange={set("restaurant_name")} className={inputCls} /></Field>
        <Field label="Phone"><input value={form.phone || ""} onChange={set("phone")} className={inputCls} /></Field>
        <Field label="Logo URL">
          <div className="flex gap-1.5">
            <input value={form.logo_url || ""} onChange={set("logo_url")} className={inputCls} placeholder="https://…" />
            <button type="button" onClick={() => saveOne("logo_url")} disabled={savingField === "logo_url"}
              className="flex-shrink-0 px-3 rounded-xl bg-stone-800 text-white text-xs font-bold disabled:opacity-60">
              {savingField === "logo_url" ? "…" : savedField === "logo_url" ? "✓" : "Save"}
            </button>
          </div>
        </Field>
        <Field label="Version"><input value={form.version || ""} onChange={set("version")} className={inputCls} /></Field>
        <div className="col-span-2">
          <Field label="Restaurant Address"><input value={form.address || ""} onChange={set("address")} className={inputCls} /></Field>
        </div>
        <div className="col-span-2">
          <Field label="GST Number (GSTIN — printed on invoices)">
            <input value={form.gst_number || ""} onChange={set("gst_number")}
              placeholder="e.g. 09ACOFA177BK1ZS" className={inputCls} />
          </Field>
        </div>
        <Field label="Opening Time"><input type="time" value={form.opening_time || ""} onChange={set("opening_time")} className={inputCls} /></Field>
        <Field label="Closing Time"><input type="time" value={form.closing_time || ""} onChange={set("closing_time")} className={inputCls} /></Field>
      </div>

      <div className="grid grid-cols-2 gap-3 mt-3">
        {[["emergency_close", "🚨 Emergency Close"], ["holiday_mode", "🏖️ Holiday Mode"], ["hide_unavailable_items", "🙈 Hide Unavailable Items"]].map(([k, label]) => (
          <button key={k} onClick={() => setForm(f => ({ ...f, [k]: !f[k] }))}
            className={`flex items-center justify-between px-3 py-2.5 rounded-xl border-2 text-xs font-bold ${form[k] ? "bg-red-50 border-red-200 text-red-600" : "bg-stone-50 border-stone-200 text-stone-500"}`}>
            {label}
            <div className={`w-9 h-5 rounded-full relative transition-all ${form[k] ? "bg-red-500" : "bg-stone-300"}`}>
              <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${form[k] ? "right-0.5" : "left-0.5"}`} />
            </div>
          </button>
        ))}
      </div>

      <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mt-4 mb-2">Delivery Charges</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Base Delivery Charge (₹)"><input type="number" value={form.base_delivery_charge ?? ""} onChange={numSet("base_delivery_charge")} className={inputCls} /></Field>
        <Field label="Base Distance (km)"><input type="number" value={form.base_distance_km ?? ""} onChange={numSet("base_distance_km")} className={inputCls} /></Field>
        <Field label="Additional Charge / km (₹)"><input type="number" value={form.per_km_charge ?? ""} onChange={numSet("per_km_charge")} className={inputCls} /></Field>
        <Field label="Rider Earning / km (₹)"><input type="number" value={form.earning_per_km ?? ""} onChange={numSet("earning_per_km")} className={inputCls} placeholder="10" /></Field>
        <Field label="Max Delivery Distance (km)"><input type="number" value={form.delivery_radius_km ?? ""} onChange={numSet("delivery_radius_km")} className={inputCls} /></Field>
        <Field label="Free Delivery Above (₹)"><input type="number" value={form.free_delivery_above ?? ""} onChange={numSet("free_delivery_above")} className={inputCls} /></Field>
        <Field label="Avg Delivery Speed (km/h)"><input type="number" value={form.avg_delivery_speed_kmph ?? ""} onChange={numSet("avg_delivery_speed_kmph")} className={inputCls} /></Field>
        <Field label="Restaurant Latitude"><input type="number" step="0.0001" value={form.restaurant_lat ?? ""} onChange={numSet("restaurant_lat")} className={inputCls} /></Field>
        <Field label="Restaurant Longitude"><input type="number" step="0.0001" value={form.restaurant_lng ?? ""} onChange={numSet("restaurant_lng")} className={inputCls} /></Field>
      </div>

      <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mt-4 mb-2">Billing</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Minimum Order Value (₹)"><input type="number" value={form.min_order_value ?? ""} onChange={numSet("min_order_value")} className={inputCls} /></Field>
        <Field label="Packing Charge (₹)"><input type="number" value={form.packing_charge ?? ""} onChange={numSet("packing_charge")} className={inputCls} /></Field>
        <Field label="GST Percentage (%)"><input type="number" value={form.gst_percent ?? ""} onChange={numSet("gst_percent")} className={inputCls} /></Field>
      </div>

      <button onClick={doSave} disabled={saving}
        className="w-full mt-4 bg-stone-800 text-white py-2.5 rounded-xl text-xs font-bold disabled:opacity-60 flex items-center justify-center gap-1.5">
        <Save size={13} /> {saving ? "Saving…" : saved ? "✓ Saved!" : "Save Business Settings"}
      </button>
    </Section>
  );
}

// ─────────────────────────────────────────────────────────
//  CATEGORY ENABLE/DISABLE (Phase 2)
// ─────────────────────────────────────────────────────────
function CategoriesSection() {
  const toast = useToast();
  const [cats, setCats]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing]   = useState(null);
  const [saving, setSaving]     = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const blank = { label: "", emoji: "🍽️", img: "", sort_order: 0, enabled: true };
  const [form, setForm]         = useState(blank);

  // ── Image upload (mirrors MenuTab pattern) ──
  const [uploadingImg, setUploadingImg] = useState(false);
  const imgInputRef = useRef(null);

  const handleImgUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const isJpg = file.type === "image/jpeg"
      || file.name.toLowerCase().endsWith(".jpg")
      || file.name.toLowerCase().endsWith(".jpeg");
    if (!isJpg) {
      toast.error("Only JPG/JPEG images are allowed.");
      if (imgInputRef.current) imgInputRef.current.value = "";
      return;
    }

    if (!SUPABASE_READY) {
      toast.error("Storage not configured. Please set up Supabase environment variables.");
      return;
    }

    setUploadingImg(true);
    // Compress before upload: resize to max 400px wide, 65% JPEG quality
    let uploadFile = file;
    try { uploadFile = await compressImage(file); } catch { /* fall back to original if compression fails */ }
    const baseName = file.name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9]/gi, "_");
    const fileName = `categories/${Date.now()}_${baseName}.jpg`;
    const { data, error } = await supabase.storage
      .from("menu-images")
      .upload(fileName, uploadFile, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });

    if (error) {
      toast.error(`Upload failed: ${error.message}`);
    } else {
      const { data: { publicUrl } } = supabase.storage
        .from("menu-images")
        .getPublicUrl(data.path);
      setForm(f => ({ ...f, img: publicUrl }));
    }
    setUploadingImg(false);
    if (imgInputRef.current) imgInputRef.current.value = "";
  };

  const load = useCallback(async () => {
    if (!SUPABASE_READY) { setLoading(false); return; }
    const { data } = await supabase.from("categories").select("*").order("sort_order");
    setCats(data && data.length ? data : CATEGORIES.map((c, i) => ({ ...c, enabled: true, sort_order: i })));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const openAdd  = () => { setForm({ ...blank, sort_order: cats.length }); setEditing(null); setShowForm(true); };
  const openEdit = (c) => { setForm({ label: c.label, emoji: c.emoji || "🍽️", img: c.img || "", sort_order: c.sort_order ?? 0, enabled: c.enabled !== false }); setEditing(c.id); setShowForm(true); };

  const save = async () => {
    if (!form.label.trim()) { toast.error("Section name is required."); return; }
    setSaving(true);
    const payload = { label: form.label.trim(), emoji: form.emoji || "🍽️", img: form.img || null, sort_order: Number(form.sort_order) || 0, enabled: form.enabled };
    if (editing) {
      const { error } = await supabase.from("categories").update(payload).eq("id", editing);
      setSaving(false);
      if (error) { toast.error("Save failed — " + error.message); return; }
    } else {
      const id = form.label.trim().toLowerCase().replace(/[^a-z0-9]/g, "_") + "_" + Date.now();
      const { error } = await supabase.from("categories").insert({ id, ...payload });
      setSaving(false);
      if (error) { toast.error("Add failed — " + error.message); return; }
    }
    setShowForm(false); load();
  };

  const toggle = async (id, current) => {
    setCats(prev => prev.map(c => c.id === id ? { ...c, enabled: !current } : c));
    const { error } = await supabase.from("categories").update({ enabled: !current }).eq("id", id);
    if (error) { setCats(prev => prev.map(c => c.id === id ? { ...c, enabled: current } : c)); toast.error("Update failed — " + error.message); }
  };

  const del = async (id) => {
    if (pendingDelete !== id) { setPendingDelete(id); setTimeout(() => setPendingDelete(null), 3000); return; }
    setPendingDelete(null);
    const { error } = await supabase.from("categories").delete().eq("id", id);
    if (error) { toast.error("Delete failed — " + error.message); return; }
    load();
  };

  if (loading) return <Section emoji="📂" title="Menu Sections"><p className="text-xs text-stone-400">Loading…</p></Section>;

  return (
    <Section emoji="📂" title="Menu Sections">
      <p className="text-xs text-stone-400 mb-3">Add, edit, or hide sections. Hiding a section removes it from the customer menu without deleting items.</p>
      <div className="space-y-2 mb-3">
        {cats.map(c => (
          <div key={c.id} className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 ${c.enabled !== false ? "bg-white border-stone-100" : "bg-stone-50 border-stone-200 opacity-60"}`}>
            {c.img
              ? <img src={c.img} alt={c.label} className="w-8 h-8 rounded-lg object-cover flex-shrink-0" onError={e => e.target.style.display = "none"} />
              : <span className="text-lg flex-shrink-0">{c.emoji}</span>
            }
            <span className="flex-1 text-xs font-bold text-stone-700 truncate">{c.label}</span>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <button onClick={() => openEdit(c)} className="w-7 h-7 rounded-lg bg-orange-50 flex items-center justify-center text-orange-500 hover:bg-orange-100">
                <Edit3 size={11} />
              </button>
              <button onClick={() => toggle(c.id, c.enabled !== false)}
                className={`w-9 h-5 rounded-full relative transition-all ${c.enabled !== false ? "bg-green-500" : "bg-stone-300"}`}>
                <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${c.enabled !== false ? "right-0.5" : "left-0.5"}`} />
              </button>
              <button onClick={() => del(c.id)}
                className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${pendingDelete === c.id ? "bg-red-500 text-white" : "bg-red-50 text-red-400 hover:bg-red-100"}`}>
                {pendingDelete === c.id ? <span className="text-xs font-black">!</span> : <Trash2 size={11} />}
              </button>
            </div>
          </div>
        ))}
      </div>
      <button onClick={openAdd} className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-orange-200 text-orange-500 font-bold text-xs py-3 rounded-xl hover:bg-orange-50 active:scale-95 transition-all">
        <Plus size={14} /> Add New Section
      </button>
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/50 backdrop-blur-sm" onClick={() => setShowForm(false)}>
          <div className="w-full max-w-xl mx-auto bg-white rounded-t-3xl p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 bg-stone-200 rounded-full mx-auto mb-1" />
            <p className="font-black text-stone-800 text-base">{editing ? "Edit Section" : "Add New Section"}</p>

            {/* Emoji + Name */}
            <div className="flex gap-2">
              <div className="w-16">
                <p className="text-xs font-bold text-stone-500 mb-1">Emoji</p>
                <input value={form.emoji} onChange={e => setForm(f => ({ ...f, emoji: e.target.value }))}
                  className="w-full border-2 border-stone-200 rounded-xl px-2 py-2.5 text-center text-xl outline-none focus:border-orange-400" maxLength={2} />
              </div>
              <div className="flex-1">
                <p className="text-xs font-bold text-stone-500 mb-1">Section Name *</p>
                <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="e.g. Specials"
                  className="w-full border-2 border-stone-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-400" />
              </div>
            </div>

            {/* Sort order */}
            <div>
              <p className="text-xs font-bold text-stone-500 mb-1">Sort Order <span className="font-normal text-stone-400">(lower = first)</span></p>
              <input type="number" value={form.sort_order} onChange={e => setForm(f => ({ ...f, sort_order: e.target.value }))}
                className="w-full border-2 border-stone-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-400" />
            </div>

            {/* Cover image — upload + URL fallback */}
            <div>
              <p className="text-xs font-bold text-stone-500 mb-1 flex items-center gap-1">
                <Image size={9} /> Cover Image <span className="font-normal text-stone-400">(JPG only, optional)</span>
              </p>
              {/* File picker */}
              <label className={`flex items-center gap-2 w-full border-2 border-dashed rounded-xl px-4 py-3 cursor-pointer transition-colors
                ${uploadingImg ? "border-orange-300 bg-orange-50" : "border-stone-200 hover:border-orange-400 bg-white"}`}>
                <Image size={14} className="text-stone-400 flex-shrink-0" />
                <span className="text-sm text-stone-500 flex-1">
                  {uploadingImg ? "Uploading…" : "Click to upload JPG"}
                </span>
                <input
                  ref={imgInputRef}
                  type="file"
                  accept=".jpg,.jpeg,image/jpeg"
                  className="hidden"
                  disabled={uploadingImg}
                  onChange={handleImgUpload}
                />
              </label>
              {/* URL fallback */}
              <p className="text-[10px] text-stone-400 mt-1 mb-1">Or paste a URL directly:</p>
              <input
                value={form.img}
                onChange={e => setForm(f => ({ ...f, img: e.target.value }))}
                placeholder="https://…"
                className="w-full border-2 border-stone-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-400"
              />
              {/* Preview + remove */}
              {form.img && (
                <div className="mt-2 relative">
                  <img src={form.img} alt="preview"
                    className="h-24 w-full object-cover rounded-xl"
                    onError={e => e.target.style.display = "none"} />
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, img: "" }))}
                    className="absolute top-1 right-1 bg-black/50 text-white rounded-full p-0.5 hover:bg-black/70">
                    <X size={12} />
                  </button>
                </div>
              )}
            </div>

            {/* Visibility toggle */}
            <div className="flex items-center justify-between py-1">
              <p className="text-sm font-bold text-stone-700">Visible to customers</p>
              <button onClick={() => setForm(f => ({ ...f, enabled: !f.enabled }))}
                className={`w-12 h-6 rounded-full relative transition-all ${form.enabled ? "bg-green-500" : "bg-stone-300"}`}>
                <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${form.enabled ? "right-0.5" : "left-0.5"}`} />
              </button>
            </div>

            <div className="flex gap-2 pt-1">
              <button onClick={() => setShowForm(false)} className="flex-1 border-2 border-stone-200 text-stone-600 py-3 rounded-2xl font-bold text-sm">Cancel</button>
              <button onClick={save} disabled={saving || uploadingImg}
                className="flex-1 bg-gradient-to-r from-orange-500 to-red-500 text-white py-3 rounded-2xl font-bold text-sm disabled:opacity-60">
                {saving ? "Saving…" : editing ? "Save Changes" : "Add Section"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

// ─────────────────────────────────────────────────────────
//  SECTION WRAPPER (must be outside SettingsTab to avoid remount on every keystroke)
// ─────────────────────────────────────────────────────────
function Section({ title, emoji, children }) {
  return (
    <div className="bg-white border border-stone-100 rounded-2xl p-4 shadow-sm mb-4">
      <p className="text-sm font-bold text-stone-800 mb-3 flex items-center gap-2">{emoji} {title}</p>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  NOTIFICATIONS SECTION — Web Push via VAPID + Edge Function
// ─────────────────────────────────────────────────────────
function NotificationsSection() {
  const toast = useToast();
  const [title,     setTitle]     = useState("🍔 Burger Point");
  const [message,   setMessage]   = useState("");
  const [audience,  setAudience]  = useState("all"); // all | customers | riders
  const [sending,   setSending]   = useState(false);
  const [subCount,  setSubCount]  = useState(null);

  // Load subscription count
  useEffect(() => {
    if (!SUPABASE_READY) return;
    supabase.from("push_subscriptions").select("id", { count: "exact", head: true })
      .then(({ count }) => setSubCount(count ?? 0));
  }, []);

  const send = async () => {
    if (!message.trim()) { toast.error("Message is required."); return; }
    setSending(true);
    try {
      const { error } = await supabase.functions.invoke("send-push", {
        body: { title, message, audience },
      });
      if (error) throw error;
      toast.success(`✅ Notification sent to ${audience === "all" ? "everyone" : audience}!`);
      setMessage("");
    } catch (e) {
      toast.error("⚠️ Send failed — " + (e.message || "check Edge Function logs"));
    }
    setSending(false);
  };

  const notifyRidersOnline = async () => {
    setSending(true);
    try {
      const { error } = await supabase.functions.invoke("send-push", {
        body: {
          title: "🛵 Burger Point — Orders Live!",
          message: "The app is now accepting delivery orders. Check for new assignments.",
          audience: "riders",
        },
      });
      if (error) throw error;
      toast.success("✅ All riders notified!");
    } catch (e) {
      toast.error("⚠️ Failed — " + (e.message || "check Edge Function logs"));
    }
    setSending(false);
  };

  return (
    <Section emoji="🔔" title="Push Notifications">
      <p className="text-xs text-stone-400 mb-3">
        Send background push notifications to customers and riders — arrives even when the app is closed.
        {subCount !== null && <span className="ml-1 font-bold text-stone-600">{subCount} device{subCount !== 1 ? "s" : ""} subscribed.</span>}
      </p>

      {/* Quick action */}
      <button onClick={notifyRidersOnline} disabled={sending}
        className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-bold text-sm py-3 rounded-xl mb-4 active:scale-95 transition-transform disabled:opacity-60">
        <Bike size={14} /> Notify All Riders — App is Live
      </button>

      {/* Custom message */}
      <div className="space-y-3">
        <div>
          <p className="text-xs font-bold text-stone-500 mb-1">Audience</p>
          <div className="flex gap-2">
            {[["all", "👥 Everyone"], ["customers", "🛒 Customers"], ["riders", "🛵 Riders"]].map(([val, lbl]) => (
              <button key={val} onClick={() => setAudience(val)}
                className={`flex-1 py-2 rounded-xl text-xs font-bold border-2 transition-colors ${audience === val ? "bg-orange-500 text-white border-orange-500" : "bg-white text-stone-600 border-stone-200"}`}>
                {lbl}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="text-xs font-bold text-stone-500 mb-1">Notification Title</p>
          <input value={title} onChange={e => setTitle(e.target.value)}
            className="w-full border-2 border-stone-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-400" />
        </div>

        <div>
          <p className="text-xs font-bold text-stone-500 mb-1">Message *</p>
          <textarea value={message} onChange={e => setMessage(e.target.value)} rows={3}
            placeholder="e.g. 🎉 Happy Hour! 20% off all orders for the next 2 hours."
            className="w-full border-2 border-stone-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-400 resize-none" />
        </div>

        <button onClick={send} disabled={sending || !message.trim()}
          className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-orange-500 to-red-500 text-white font-bold text-sm py-3 rounded-xl active:scale-95 transition-transform disabled:opacity-60">
          <Send size={14} /> {sending ? "Sending…" : "Send Notification"}
        </button>

        <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5">
          <p className="text-xs font-bold text-amber-700 mb-1">⚙️ Setup required</p>
          <p className="text-xs text-amber-600">This needs the <code className="bg-amber-100 px-1 rounded">send-push</code> Edge Function deployed and VAPID keys configured. Run <code className="bg-amber-100 px-1 rounded">phase7_web_push.sql</code> first.</p>
        </div>
      </div>
    </Section>
  );
}

// ─────────────────────────────────────────────────────────
//  SETTINGS TAB
// ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────
//  PROMO BANNER + TODAY'S SPECIAL SECTION
// ─────────────────────────────────────────────────────────
function PromoBannerSection() {
  const toast = useToast();
  const { settings, loading, save } = useBusinessSettings();

  // Local form state — mirrors the DB fields we own
  const [form, setForm] = useState({
    special_label:        "Today's Special",
    special_item_id:      null,
    promo_banner_url:     null,
    promo_banner_enabled: false,
  });
  const [saving,       setSaving]       = useState(false);
  const [saved,        setSaved]        = useState(false);
  const [uploadingImg, setUploadingImg] = useState(false);
  const [menuItems,    setMenuItems]    = useState([]); // for dropdown

  // Seed form from DB on first load
  useEffect(() => {
    if (!loading) {
      setForm({
        special_label:        settings.special_label        ?? "Today's Special",
        special_item_id:      settings.special_item_id      ?? null,
        promo_banner_url:     settings.promo_banner_url     ?? null,
        promo_banner_enabled: settings.promo_banner_enabled ?? false,
      });
    }
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load all menu items for the "pin a specific item" dropdown
  useEffect(() => {
    if (!SUPABASE_READY) return;
    supabase.from("menu_items").select("id, name, category").order("name")
      .then(({ data }) => { if (data) setMenuItems(data); });
  }, []);

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value || null }));
  const toggle = (k) => setForm(f => ({ ...f, [k]: !f[k] }));

  // Image upload → supabase storage (reuses the same "menu-images" bucket under a "banners/" prefix)
  const handleBannerUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingImg(true);
    let uploadFile = file;
    try { uploadFile = await compressImage(file); } catch { /* fall back to original */ }
    const fileName = `banners/promo_banner_${Date.now()}.jpg`;
    const { data, error } = await supabase.storage
      .from("menu-images")
      .upload(fileName, uploadFile, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });
    setUploadingImg(false);
    if (error) { toast.error("Upload failed: " + error.message); return; }
    const { data: { publicUrl } } = supabase.storage.from("menu-images").getPublicUrl(data.path);
    setForm(f => ({ ...f, promo_banner_url: publicUrl }));
    toast.success("Banner uploaded!");
  };

  const doSave = async () => {
    setSaving(true);
    const { error } = await save({
      special_label:        form.special_label || "Today's Special",
      special_item_id:      form.special_item_id || null,
      promo_banner_url:     form.promo_banner_url || null,
      promo_banner_enabled: !!form.promo_banner_enabled,
    });
    setSaving(false);
    if (error) { toast.error("Save failed: " + error.message); return; }
    setSaved(true);
    toast.success("Saved!");
    setTimeout(() => setSaved(false), 2000);
  };

  const inputCls = "w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2.5 outline-none text-stone-700";

  if (loading) return <Section emoji="🎯" title="Today's Special &amp; Promo Banner"><p className="text-xs text-stone-400">Loading…</p></Section>;

  return (
    <Section emoji="🎯" title="Today's Special & Promo Banner">

      {/* ── TODAY'S SPECIAL ── */}
      <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-2">Today's Special Card</p>
      <div className="space-y-3">
        {/* Label / rename */}
        <div>
          <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Section Label</label>
          <input
            value={form.special_label ?? ""}
            onChange={e => setForm(f => ({ ...f, special_label: e.target.value }))}
            placeholder="Today's Special"
            className={inputCls}
          />
          <p className="text-[10px] text-stone-400 mt-1">Shown above the featured item card — e.g. "Independence Day's Special", "Chef's Pick"</p>
        </div>

        {/* Pin a specific item */}
        <div>
          <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Featured Item</label>
          <select
            value={form.special_item_id ?? ""}
            onChange={e => setForm(f => ({ ...f, special_item_id: e.target.value || null }))}
            className={inputCls}
          >
            <option value="">— Auto (rotate bestsellers daily) —</option>
            {menuItems.map(i => (
              <option key={i.id} value={i.id}>{i.name} · {i.category}</option>
            ))}
          </select>
          <p className="text-[10px] text-stone-400 mt-1">Pin a specific item or leave auto to rotate daily from bestsellers</p>
        </div>
      </div>

      {/* ── PROMO BANNER ── */}
      <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mt-5 mb-2">Promo Banner</p>
      <div className="space-y-3">
        {/* Enable toggle */}
        <button onClick={() => toggle("promo_banner_enabled")}
          className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 text-sm font-bold transition-all
            ${form.promo_banner_enabled ? "bg-orange-50 border-orange-300 text-orange-700" : "bg-stone-50 border-stone-200 text-stone-500"}`}>
          {form.promo_banner_enabled ? "🟠 Banner ON — showing to customers" : "⚪ Banner OFF — hidden"}
          <div className={`w-10 h-6 rounded-full relative transition-all ${form.promo_banner_enabled ? "bg-orange-500" : "bg-stone-300"}`}>
            <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${form.promo_banner_enabled ? "right-0.5" : "left-0.5"}`} />
          </div>
        </button>

        {/* Current banner preview */}
        {form.promo_banner_url && (
          <div className="rounded-xl overflow-hidden border-2 border-stone-100 relative">
            <img src={form.promo_banner_url} alt="Promo banner" className="w-full object-cover max-h-40" />
            <button onClick={() => setForm(f => ({ ...f, promo_banner_url: null }))}
              className="absolute top-2 right-2 w-7 h-7 bg-black/60 text-white rounded-full text-xs font-bold flex items-center justify-center">
              ✕
            </button>
          </div>
        )}

        {/* Upload */}
        <label className={`flex items-center gap-3 border-2 border-dashed rounded-xl px-4 py-3 cursor-pointer transition-colors
          ${uploadingImg ? "border-orange-300 bg-orange-50" : "border-stone-200 hover:border-orange-400 bg-white"}`}>
          <input type="file" accept="image/*" className="hidden" onChange={handleBannerUpload} disabled={uploadingImg} />
          <span className="text-xl">{uploadingImg ? "⏳" : "🖼️"}</span>
          <div>
            <p className="text-sm font-bold text-stone-700">{uploadingImg ? "Uploading…" : form.promo_banner_url ? "Replace banner image" : "Upload banner image (JPG)"}</p>
            <p className="text-[10px] text-stone-400">Shown as full-screen popup on app open + smaller block in cart</p>
          </div>
        </label>
      </div>

      <button onClick={doSave} disabled={saving || uploadingImg}
        className="w-full mt-4 bg-stone-800 text-white py-2.5 rounded-xl text-xs font-bold disabled:opacity-60 flex items-center justify-center gap-1.5">
        <Save size={13} /> {saving ? "Saving…" : saved ? "✓ Saved!" : "Save Special & Banner Settings"}
      </button>
    </Section>
  );
}

function SettingsTab({ riders, setRiders, onLogout, busy, setBusy, busySaving, setBusySaving }) {
  const toast = useToast();
  // Busy mode (state lifted to AdminApp root for top-bar toggle access)
  const [busyLoaded, setBusyLoaded] = useState(false);

  // ── Bulk image recompress ──
  const [recompressing, setRecompressing] = useState(false);
  const [recompressLog, setRecompressLog] = useState([]);

  const bulkRecompress = async () => {
    setRecompressing(true);
    setRecompressLog([]);
    const log = (msg) => setRecompressLog(prev => [...prev, msg]);

    try {
      // Fetch all menu items and categories with Supabase storage images
      const [{ data: menuItems }, { data: categories }] = await Promise.all([
        supabase.from("menu_items").select("id, name, img").not("img", "is", null),
        supabase.from("categories").select("id, label, img").not("img", "is", null),
      ]);

      const supabaseBase = `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/menu-images/`;

      const toProcess = [
        ...(menuItems || []).filter(i => i.img?.includes("/menu-images/")).map(i => ({ ...i, table: "menu_items", nameField: "name" })),
        ...(categories || []).filter(i => i.img?.includes("/menu-images/")).map(i => ({ ...i, name: i.label, table: "categories", nameField: "label" })),
      ];

      log(`Found ${toProcess.length} Supabase-hosted images to recompress…`);

      let done = 0, skipped = 0, failed = 0;

      for (const item of toProcess) {
        try {
          // Fetch the image as a blob
          const res = await fetch(item.img);
          if (!res.ok) { log(`⚠️ Skip ${item.name} — fetch failed`); failed++; continue; }
          const originalBlob = await res.blob();
          const originalSize = originalBlob.size;

          // Compress it — use blob directly to avoid `new File` minification issues
          const compressed = await compressBlob(originalBlob);

          // Only re-upload if we actually saved >10%
          if (compressed.size >= originalSize * 0.9) {
            log(`→ Skip ${item.name} — already small (${Math.round(originalSize/1024)}KB)`);
            skipped++;
            continue;
          }

          // Re-upload to same path
          const storagePath = item.img.replace(supabaseBase, "");
          const { error } = await supabase.storage.from("menu-images").upload(storagePath, compressed, {
            contentType: "image/jpeg", upsert: true, cacheControl: "31536000",
          });

          if (error) { log(`❌ ${item.name} — upload error: ${error.message}`); failed++; continue; }

          log(`✅ ${item.name}: ${Math.round(originalSize/1024)}KB → ${Math.round(compressed.size/1024)}KB`);
          done++;
        } catch (e) {
          log(`❌ ${item.name} — ${e.message}`);
          failed++;
        }
      }

      log(`\nDone! ✅ ${done} recompressed, ⏭️ ${skipped} skipped, ❌ ${failed} failed.`);
      if (done > 0) toast.success(`Recompressed ${done} images!`);
    } catch (e) {
      log(`Fatal error: ${e.message}`);
      toast.error("Recompress failed — check console.");
    } finally {
      setRecompressing(false);
    }
  };

  // Wait times
  const [waitTimes, setWaitTimes] = useState(() => {
    try { return JSON.parse(localStorage.getItem("bp_wait_times") || '{"dine-in":15,"takeaway":20,"delivery":40}'); } catch { return { "dine-in": 15, takeaway: 20, delivery: 40 }; }
  });

  // (Riders are managed in the dedicated Riders tab)

  // Coupons
  const [coupons,   setCoupons]   = useState([]);
  const [couponForm, setCouponForm] = useState({ code: "", discount_type: "flat", discount_value: "", min_order: "", max_discount: "", expiry: "" });
  const [couponErr, setCouponErr] = useState("");
  const [couponSaving, setCouponSaving] = useState(false);

  // (Reservations are now managed in the Orders tab via root AdminApp state)

  useEffect(() => {
    if (!SUPABASE_READY) return;
    // Load busy mode + riders from Supabase
    supabase.from("busy_mode").select("*").eq("id", 1).single()
      .then(({ data }) => {
        if (data) {
          setBusy(data);
          if (data.riders_json) {
            try {
              const r = JSON.parse(data.riders_json);
              setRiders(r);
              localStorage.setItem("bp_riders", JSON.stringify(r));
            } catch {}
          }
        }
        setBusyLoaded(true);
      });
    // Load coupons
    supabase.from("coupons").select("*").order("created_at", { ascending: false })
      .then(({ data }) => { if (data) setCoupons(data); });
  }, []);

  const saveBusy = async () => {
    setBusySaving(true);
    const payload = { is_busy: busy.is_busy, message: busy.message, opens_at: busy.opens_at };
    const { error } = await supabase.from("busy_mode").upsert({ id: 1, ...payload });
    setBusySaving(false);
    if (error) { toast.error("⚠️ Couldn't save kitchen status — " + error.message); return; }
    toast.success("Kitchen status updated.");
  };

  const saveWaitTimes = () => {
    localStorage.setItem("bp_wait_times", JSON.stringify(waitTimes));
    toast.success("Wait times saved!");
  };



  const addCoupon = async () => {
    if (!couponForm.code.trim())               { setCouponErr("Code required."); return; }
    if (!couponForm.discount_value)            { setCouponErr("Discount value required."); return; }
    setCouponSaving(true);
    const { error } = await supabase.from("coupons").insert({
      code: couponForm.code.trim().toUpperCase(),
      discount_type:  couponForm.discount_type,
      discount_value: Number(couponForm.discount_value),
      min_order:      Number(couponForm.min_order) || 0,
      max_discount:   Number(couponForm.max_discount) || null,
      expiry:         couponForm.expiry || null,
      is_active:      true,
    });
    setCouponSaving(false);
    if (error) { setCouponErr(error.message); return; }
    setCouponErr(""); setCouponForm({ code: "", discount_type: "flat", discount_value: "", min_order: "", max_discount: "", expiry: "" });
    const { data } = await supabase.from("coupons").select("*").order("created_at", { ascending: false });
    if (data) setCoupons(data);
  };

  const toggleCoupon = async (id, current) => {
    setCoupons(prev => prev.map(c => c.id === id ? { ...c, is_active: !current } : c));
    const { error } = await supabase.from("coupons").update({ is_active: !current }).eq("id", id);
    if (error) {
      setCoupons(prev => prev.map(c => c.id === id ? { ...c, is_active: current } : c));
      toast.error("⚠️ Couldn't toggle coupon — " + error.message);
    }
  };

  return (
    <div className="space-y-0">
      <BusinessSettingsSection />
      <PromoBannerSection />
      <CategoriesSection />
      <NotificationsSection />
      {/* ── BUSY MODE ── */}
      <Section emoji="🔴" title="Open / Closed Toggle">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-sm font-bold text-stone-700">{busy.is_busy ? "🔴 Restaurant is CLOSED" : "🟢 Restaurant is OPEN"}</p>
            <p className="text-xs text-stone-400">Toggle to stop / resume incoming orders</p>
          </div>
          <button onClick={() => setBusy(b => ({ ...b, is_busy: !b.is_busy }))}
            className={`w-14 h-7 rounded-full transition-all relative ${busy.is_busy ? "bg-red-500" : "bg-green-500"}`}>
            <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-all ${busy.is_busy ? "right-0.5" : "left-0.5"}`} />
          </button>
        </div>
        {busy.is_busy && (
          <div className="space-y-2 mb-3">
            <div>
              <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Closed Message</label>
              <input value={busy.message} onChange={e => setBusy(b => ({ ...b, message: e.target.value }))}
                className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2.5 outline-none text-stone-700" />
            </div>
            <div>
              <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Opens At <span className="font-normal normal-case">(shown to customers)</span></label>
              <input value={busy.opens_at} onChange={e => setBusy(b => ({ ...b, opens_at: e.target.value }))} placeholder="e.g. 11:00 AM"
                className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2.5 outline-none text-stone-700" />
            </div>
          </div>
        )}
        <button onClick={saveBusy} disabled={busySaving}
          className="w-full bg-stone-800 text-white py-2.5 rounded-xl text-xs font-bold disabled:opacity-60 flex items-center justify-center gap-1.5">
          <Save size={12} /> {busySaving ? "Saving…" : "Save Busy Mode"}
        </button>
      </Section>

      {/* ── WAIT TIMES ── */}
      <Section emoji="⏱️" title="Estimated Wait Times">
        <p className="text-xs text-stone-400 mb-3">Shown to customers on the order tracker</p>
        {[
          { key: "dine-in", label: "Dine-In", emoji: "🍽️" },
          { key: "takeaway", label: "Takeaway", emoji: "📦" },
          { key: "delivery", label: "Delivery", emoji: "🛵" },
        ].map(t => (
          <div key={t.key} className="flex items-center gap-3 mb-2">
            <span className="text-base">{t.emoji}</span>
            <span className="text-sm text-stone-600 flex-1">{t.label}</span>
            <div className="flex items-center gap-1.5 bg-stone-50 border border-stone-200 rounded-xl px-3 py-1.5">
              <input type="number" value={waitTimes[t.key]} onChange={e => setWaitTimes(w => ({ ...w, [t.key]: Number(e.target.value) }))}
                className="w-12 text-sm font-bold text-stone-800 bg-transparent outline-none text-center" />
              <span className="text-xs text-stone-400">mins</span>
            </div>
          </div>
        ))}
        <button onClick={saveWaitTimes} className="w-full mt-2 bg-stone-800 text-white py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5">
          <Save size={12} /> Save Wait Times
        </button>
      </Section>

      {/* ── COUPONS ── */}
      <Section emoji="🏷️" title="Promo Codes / Coupons">
        <div className="space-y-2 mb-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Code</label>
              <input value={couponForm.code} onChange={e => setCouponForm(f => ({ ...f, code: e.target.value.toUpperCase() }))} placeholder="BURGER10"
                className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2 outline-none text-stone-700 font-mono" />
            </div>
            <div>
              <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Type</label>
              <select value={couponForm.discount_type} onChange={e => setCouponForm(f => ({ ...f, discount_type: e.target.value }))}
                className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2 outline-none text-stone-700">
                <option value="flat">Flat ₹ Off</option>
                <option value="percent">% Off</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Value</label>
              <input type="number" value={couponForm.discount_value} onChange={e => setCouponForm(f => ({ ...f, discount_value: e.target.value }))}
                placeholder={couponForm.discount_type === "percent" ? "10" : "50"}
                className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2 outline-none text-stone-700" />
            </div>
            <div>
              <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Min Order ₹</label>
              <input type="number" value={couponForm.min_order} onChange={e => setCouponForm(f => ({ ...f, min_order: e.target.value }))} placeholder="0"
                className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2 outline-none text-stone-700" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {couponForm.discount_type === "percent" && (
              <div>
                <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Max Discount ₹</label>
                <input type="number" value={couponForm.max_discount} onChange={e => setCouponForm(f => ({ ...f, max_discount: e.target.value }))} placeholder="100"
                  className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2 outline-none text-stone-700" />
              </div>
            )}
            <div>
              <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Expiry Date</label>
              <input type="date" value={couponForm.expiry} onChange={e => setCouponForm(f => ({ ...f, expiry: e.target.value }))}
                className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2 outline-none text-stone-700" />
            </div>
          </div>
        </div>
        {couponErr && <p className="text-red-500 text-xs mb-2">{couponErr}</p>}
        <button onClick={addCoupon} disabled={couponSaving}
          className="w-full bg-orange-500 text-white py-2.5 rounded-xl text-xs font-bold disabled:opacity-60 flex items-center justify-center gap-1.5 mb-3">
          <Plus size={12} /> {couponSaving ? "Saving…" : "Create Coupon"}
        </button>
        {/* Coupon list */}
        <div className="space-y-2">
          {coupons.map(c => (
            <div key={c.id} className={`flex items-center gap-3 bg-stone-50 rounded-xl px-3 py-2.5 ${!c.is_active ? "opacity-50" : ""}`}>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-stone-800 font-mono">{c.code}</p>
                <p className="text-xs text-stone-400">
                  {c.discount_type === "percent" ? `${c.discount_value}% off` : `₹${c.discount_value} off`}
                  {c.min_order ? ` · min ₹${c.min_order}` : ""}
                  {c.expiry ? ` · expires ${c.expiry}` : ""}
                </p>
              </div>
              <button onClick={() => toggleCoupon(c.id, c.is_active)}
                className={`text-[10px] font-bold px-2.5 py-1 rounded-lg ${c.is_active ? "bg-green-100 text-green-700" : "bg-stone-200 text-stone-500"}`}>
                {c.is_active ? "Active" : "Disabled"}
              </button>
            </div>
          ))}
        </div>
      </Section>

      {/* ── BULK IMAGE RECOMPRESS ── */}
      <Section title="🗜️ Image Optimiser">
        <p className="text-xs text-stone-500 mb-3">
          Re-compress all existing menu &amp; category images in Supabase storage to reduce egress usage. Only images that can be meaningfully compressed will be updated.
        </p>
        <button
          onClick={bulkRecompress}
          disabled={recompressing}
          className="w-full bg-orange-500 text-white py-2.5 rounded-xl text-xs font-bold disabled:opacity-60 flex items-center justify-center gap-1.5 mb-3"
        >
          {recompressing ? "⏳ Recompressing…" : "🗜️ Recompress All Images Now"}
        </button>
        {recompressLog.length > 0 && (
          <div className="bg-stone-900 text-green-400 rounded-xl p-3 text-[10px] font-mono max-h-48 overflow-y-auto space-y-0.5">
            {recompressLog.map((line, i) => <div key={i}>{line}</div>)}
          </div>
        )}
      </Section>

      {/* ── LOGOUT ── */}
      <div className="pt-2 pb-6">
        <button onClick={onLogout}
          className="w-full flex items-center justify-center gap-2 border-2 border-red-200 text-red-500 font-bold text-sm py-3 rounded-2xl hover:bg-red-50 transition-all">
          <LogOut size={15} /> Logout from Admin
        </button>
        <button onClick={() => window.location.hash = ""} className="w-full text-xs text-stone-400 mt-3 underline">← Back to customer menu</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  RIDERS TAB
// ─────────────────────────────────────────────────────────
function RidersTab() {
  const toast = useToast();
  const [riders,   setRiders]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editRider, setEditRider] = useState(null);
  const [stats,    setStats]    = useState({});
  const blank = { rider_id: "", full_name: "", phone_number: "", password: "" };
  const [form, setForm]         = useState(blank);
  const [saving, setSaving]     = useState(false);
  const [formErr, setFormErr]   = useState("");
  const [resetId, setResetId]   = useState(null);
  const [newPwd, setNewPwd]     = useState("");
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from("riders").select("*").order("created_at");
    setLoading(false);
    if (data) {
      setRiders(data);
      // Load delivery counts
      const { data: orders } = await supabase.from("orders")
        .select("rider_id, rider_status, delivered_at").eq("rider_status", "delivered");
      const today = new Date().toISOString().split("T")[0];
      const s = {};
      (orders || []).forEach(o => {
        if (!s[o.rider_id]) s[o.rider_id] = { total: 0, today: 0 };
        s[o.rider_id].total++;
        if (o.delivered_at?.slice(0, 10) === today) s[o.rider_id].today++;
      });
      setStats(s);
    }
  }, []);

  useEffect(() => { if (SUPABASE_READY) load(); }, [load]);

  const openCreate = () => {
    // Auto-generate rider_id
    const next = `BP${String(riders.length + 1).padStart(3, "0")}`;
    setForm({ ...blank, rider_id: next }); setEditRider(null); setFormErr(""); setShowForm(true);
  };
  const openEdit = (r) => {
    setForm({ rider_id: r.rider_id, full_name: r.full_name, phone_number: r.phone_number, password: "" });
    setEditRider(r); setFormErr(""); setShowForm(true);
  };

  const save = async () => {
    if (!form.rider_id.trim()) { setFormErr("Rider ID required."); return; }
    if (!form.full_name.trim()) { setFormErr("Name required."); return; }
    if (!/^\d{10}$/.test(form.phone_number)) { setFormErr("Valid 10-digit phone required."); return; }
    if (!editRider && !form.password) { setFormErr("Password required."); return; }
    setSaving(true); setFormErr("");
    if (editRider) {
      const { error } = await supabase.from("riders").update({ full_name: form.full_name.trim(), phone_number: form.phone_number, updated_at: new Date().toISOString() }).eq("rider_id", editRider.rider_id);
      setSaving(false);
      if (error) { setFormErr("Save failed — " + error.message); return; }
    } else {
      const { data } = await supabase.rpc("create_rider_with_password", { p_rider_id: form.rider_id.trim().toUpperCase(), p_full_name: form.full_name.trim(), p_phone: form.phone_number, p_password: form.password });
      if (!data?.success) { setFormErr(data?.error || "Failed."); setSaving(false); return; }
    }
    setSaving(false); setShowForm(false); load();
  };

  const toggleActive = async (r) => {
    setRiders(prev => prev.map(x => x.rider_id === r.rider_id ? { ...x, active: !r.active } : x));
    const { error } = await supabase.from("riders").update({ active: !r.active, updated_at: new Date().toISOString() }).eq("rider_id", r.rider_id);
    if (error) {
      setRiders(prev => prev.map(x => x.rider_id === r.rider_id ? { ...x, active: r.active } : x));
      toast.error("⚠️ Couldn't update rider — " + error.message);
    }
  };

  const changeAvail = async (r, avail) => {
    setRiders(prev => prev.map(x => x.rider_id === r.rider_id ? { ...x, availability: avail } : x));
    const { error } = await supabase.from("riders").update({ availability: avail, updated_at: new Date().toISOString() }).eq("rider_id", r.rider_id);
    if (error) {
      setRiders(prev => prev.map(x => x.rider_id === r.rider_id ? { ...x, availability: r.availability } : x));
      toast.error("⚠️ Couldn't update availability — " + error.message);
    }
  };

  const [pendingRiderDelete, setPendingRiderDelete] = useState(null);
  const deleteRider = async (r) => {
    if (pendingRiderDelete !== r.rider_id) {
      setPendingRiderDelete(r.rider_id);
      setTimeout(() => setPendingRiderDelete(null), 3000);
      return;
    }
    setPendingRiderDelete(null);
    const { error } = await supabase.from("riders").delete().eq("rider_id", r.rider_id);
    if (error) { toast.error("⚠️ Delete failed — " + error.message); return; }
    load();
  };

  const resetPwd = async () => {
    if (!newPwd || newPwd.length < 6) return;
    setResetting(true);
    const { error } = await supabase.rpc("reset_rider_password", { p_rider_id: resetId, p_new_password: newPwd });
    setResetting(false);
    if (error) { toast.error("⚠️ Password reset failed — " + error.message); return; }
    toast.success("Password reset successfully.");
    setResetId(null); setNewPwd("");
  };

  const AVAIL = { Available: "bg-green-100 text-green-700", Busy: "bg-orange-100 text-orange-700", Offline: "bg-stone-100 text-stone-500" };

  if (loading) return (
    <div className="space-y-3 pt-2">
      {Array.from({ length: 4 }).map((_, i) => <RiderCardSkeleton key={i} />)}
    </div>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="font-bold text-stone-800">Rider Management</p>
          <p className="text-xs text-stone-400">{riders.length} riders · <a href="#rider" target="_blank" className="text-orange-500 underline">Open Rider Portal ↗</a></p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-1.5 bg-orange-500 text-white text-xs font-bold px-4 py-2.5 rounded-xl shadow-sm active:scale-95 transition-transform">
          <Plus size={13} /> Add Rider
        </button>
      </div>

      {riders.length === 0 ? (
        <div className="text-center py-12 bg-stone-50 rounded-2xl border-2 border-dashed border-stone-200">
          <p className="text-3xl mb-2">🛵</p>
          <p className="text-sm font-bold text-stone-600 mb-1">No riders yet</p>
          <button onClick={openCreate} className="bg-orange-500 text-white text-xs font-bold px-4 py-2 rounded-xl mt-2">Add First Rider</button>
        </div>
      ) : (
        <div className="space-y-3">
          {riders.map(r => {
            const s = stats[r.rider_id] || { total: 0, today: 0 };
            return (
              <div key={r.rider_id} className={`bg-white border rounded-2xl p-4 ${!r.active ? "opacity-50" : "border-stone-100"}`}>
                <div className="flex items-start gap-3">
                  <div className="w-11 h-11 bg-gradient-to-br from-orange-100 to-amber-100 rounded-2xl flex items-center justify-center text-xl flex-shrink-0">🛵</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-bold text-stone-800 text-sm">{r.full_name}</p>
                      <span className="font-mono text-[10px] bg-stone-100 text-stone-500 px-1.5 py-0.5 rounded">{r.rider_id}</span>
                      {!r.active && <span className="text-[10px] bg-red-100 text-red-600 font-bold px-1.5 py-0.5 rounded-full">Disabled</span>}
                    </div>
                    <p className="text-xs text-stone-400 mt-0.5">{r.phone_number}</p>
                    <div className="flex items-center gap-3 mt-2 flex-wrap">
                      <span className="text-[10px] text-stone-500">📦 {s.total} total · {s.today} today</span>
                      {/* Availability quick-toggle */}
                      <div className="flex gap-1">
                        {["Available","Busy","Offline"].map(a => (
                          <button key={a} onClick={() => changeAvail(r, a)}
                            className={`text-[9px] font-bold px-2 py-0.5 rounded-full transition-all ${r.availability === a ? AVAIL[a] : "bg-stone-50 text-stone-300"}`}>
                            {a}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
                {/* Action buttons */}
                <div className="flex gap-2 mt-3">
                  <button onClick={() => openEdit(r)} className="flex-1 text-xs font-bold py-2 rounded-xl bg-stone-100 text-stone-600">✏️ Edit</button>
                  <button onClick={() => { setResetId(r.rider_id); setNewPwd(""); }} className="flex-1 text-xs font-bold py-2 rounded-xl bg-blue-50 text-blue-600">🔑 Reset Pwd</button>
                  <button onClick={() => toggleActive(r)} className={`flex-1 text-xs font-bold py-2 rounded-xl ${r.active ? "bg-orange-50 text-orange-600" : "bg-green-50 text-green-600"}`}>
                    {r.active ? "Disable" : "Enable"}
                  </button>
                  <button onClick={() => deleteRider(r)}
                    className={`rounded-xl flex items-center justify-center flex-shrink-0 transition-all ${pendingRiderDelete === r.rider_id ? "bg-red-500 text-white text-[10px] font-bold px-2 h-9" : "w-9 h-9 bg-red-50"}`}>
                    {pendingRiderDelete === r.rider_id ? "Sure?" : <Trash2 size={13} className="text-red-400" />}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create/Edit form modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/60 backdrop-blur-sm" onClick={() => setShowForm(false)}>
          <div className="w-full bg-white rounded-t-3xl max-w-xl mx-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 bg-stone-200 rounded-full mx-auto mb-4" />
            <h3 className="font-bold text-stone-800 mb-4">{editRider ? "Edit Rider" : "Add New Rider"}</h3>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Rider ID *</label>
                  <input value={form.rider_id} onChange={e => setForm(f => ({ ...f, rider_id: e.target.value.toUpperCase() }))}
                    disabled={!!editRider} placeholder="BP001"
                    className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2.5 outline-none font-mono disabled:opacity-50" />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Phone *</label>
                  <input value={form.phone_number} onChange={e => setForm(f => ({ ...f, phone_number: e.target.value.replace(/\D/g,"").slice(0,10) }))}
                    placeholder="10-digit" inputMode="numeric"
                    className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2.5 outline-none" />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Full Name *</label>
                <input value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} placeholder="Rider's full name"
                  className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2.5 outline-none" />
              </div>
              {!editRider && (
                <div>
                  <label className="text-[10px] font-bold text-stone-400 uppercase tracking-widest block mb-1">Password *</label>
                  <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="Min 6 characters"
                    className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2.5 outline-none" />
                </div>
              )}
              {formErr && <p className="text-red-500 text-xs">{formErr}</p>}
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setShowForm(false)} className="flex-1 py-3 rounded-xl border-2 border-stone-200 text-stone-500 text-sm font-bold">Cancel</button>
              <button onClick={save} disabled={saving}
                className="flex-1 py-3 rounded-xl bg-gradient-to-r from-orange-500 to-red-500 text-white text-sm font-bold disabled:opacity-60">
                {saving ? "Saving…" : editRider ? "Save Changes" : "Create Rider"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset password modal */}
      {resetId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setResetId(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-xs" onClick={e => e.stopPropagation()}>
            <p className="font-bold text-stone-800 mb-1">Reset Password</p>
            <p className="text-xs text-stone-400 mb-4">Rider ID: <span className="font-mono font-bold">{resetId}</span></p>
            <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} placeholder="New password (min 6 chars)"
              className="w-full text-sm border-2 border-stone-200 focus:border-orange-400 rounded-xl px-3 py-2.5 outline-none mb-3" />
            <div className="flex gap-2">
              <button onClick={() => setResetId(null)} className="flex-1 py-2.5 rounded-xl border-2 border-stone-200 text-stone-500 text-sm font-bold">Cancel</button>
              <button onClick={resetPwd} disabled={resetting || newPwd.length < 6}
                className="flex-1 py-2.5 rounded-xl bg-blue-500 text-white text-sm font-bold disabled:opacity-50">
                {resetting ? "Resetting…" : "Reset"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  NEW ORDER POPUP
// ─────────────────────────────────────────────────────────
function NewOrderPopup({ order, count, onAck }) {
  useEffect(() => {
    if (!order) return;
    const t = setTimeout(() => onAck(), 12000);
    return () => clearTimeout(t);
  }, [order, onAck]);

  if (!order) return null;
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[999] w-full max-w-sm px-4"
         style={{ animation: "slideDown 0.35s cubic-bezier(.22,1,.36,1)" }}>
      <style>{`@keyframes slideDown{from{opacity:0;transform:translateX(-50%) translateY(-20px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}`}</style>
      <div className="bg-white rounded-2xl shadow-2xl border-2 border-orange-500 overflow-hidden">
        <div className="bg-gradient-to-r from-orange-500 to-red-500 px-4 py-2.5 flex items-center gap-2">
          <span className="text-white font-black text-sm">🔔 NEW ORDER{count > 1 ? ` (+${count - 1} more)` : ""}</span>
          <span className="ml-auto text-orange-100 text-xs font-bold">₹{order.total}</span>
        </div>
        <div className="px-4 py-3">
          <p className="font-bold text-stone-800">{order.table_label || order.customer_name || "Customer"}</p>
          <p className="text-xs text-stone-400 mt-0.5">
            {order.order_type} · {order.items?.length} item{order.items?.length !== 1 ? "s" : ""} · {order.time}
          </p>
          <div className="flex gap-2 mt-3">
            <button onClick={onAck}
              className="flex-1 bg-gradient-to-r from-orange-500 to-red-500 text-white text-sm font-bold py-2.5 rounded-xl active:scale-95 transition-transform">
              ✓ Got It
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  ORDER NOTIFICATION HOOK
// ─────────────────────────────────────────────────────────
function useOrderNotifications(orders, authed) {
  const prevIdsRef      = useRef(new Set());
  const isFirstLoadRef  = useRef(true);
  const unackedRef      = useRef(new Set());
  const repeatRef       = useRef(null);
  const flashRef        = useRef(null);
  const [popup, setPopup]           = useState(null);
  const [unreadCount, setUnreadCount] = useState(0);

  // Request browser notification permission once
  // All browser notification / audio / tab-flash wiring is desktop-only.
  // On mobile these APIs cause crashes or are silently blocked anyway.
  const isMobile = /Mobi|Android|iPhone|iPad|iPod|Touch/i.test(navigator.userAgent);

  useEffect(() => {
    if (!isMobile && authed && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, [authed, isMobile]);

  // Reuse one AudioContext for the lifetime of the hook.
  // Mobile Safari caps concurrent AudioContexts at ~6 — creating a new one
  // on every chime (which can fire every 15s + 60s stuck check) blows past
  // that cap quickly and crashes the page on mobile.
  const audioCtxRef = useRef(null);
  function getAudioCtx() {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtxRef.current;
  }

  const playChime = useCallback(() => {
    // Skip audio on mobile/tablet — AudioContext on mobile browsers causes
    // crashes and "Something went wrong" errors. Sound is desktop-only.
    const isMobile = /Mobi|Android|iPhone|iPad|iPod|Touch/i.test(navigator.userAgent);
    if (isMobile) return;
    try {
      const ctx = getAudioCtx();
      const doPlay = () => {
        const master = ctx.createGain();
        master.gain.value = 0.65;
        master.connect(ctx.destination);
        const note = (freq, t, dur, type = "triangle") => {
          const osc = ctx.createOscillator();
          const g   = ctx.createGain();
          osc.connect(g); g.connect(master);
          osc.type = type;
          osc.frequency.setValueAtTime(freq, ctx.currentTime + t);
          g.gain.setValueAtTime(0, ctx.currentTime + t);
          g.gain.linearRampToValueAtTime(0.7, ctx.currentTime + t + 0.015);
          g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + dur);
          osc.start(ctx.currentTime + t);
          osc.stop(ctx.currentTime + t + dur + 0.02);
        };
        note(523,  0,    0.14);
        note(659,  0.13, 0.14);
        note(784,  0.26, 0.14);
        note(1047, 0.39, 0.55, "sine");
        note(880,  0.55, 0.35, "sine");
      };
      if (ctx.state === "suspended") {
        ctx.resume().then(doPlay).catch(() => {});
      } else {
        doPlay();
      }
    } catch {}
  }, []);

  const startFlash = useCallback((n) => {
    clearInterval(flashRef.current);
    const orig  = document.title;
    const alert = `🔴 ${n} New Order${n > 1 ? "s" : ""}!`;
    let vis = true;
    flashRef.current = setInterval(() => {
      document.title = vis ? alert : orig;
      vis = !vis;
    }, 650);
    setTimeout(() => { clearInterval(flashRef.current); document.title = "Burger Point Admin"; }, 12000);
  }, []);

  // Dismiss the popup banner only — does NOT silence the repeat chime.
  // The chime keeps nagging every 15s until the order is actually accepted
  // (removed from unackedRef below), so dismissing the banner can't be
  // mistaken for confirming the order.
  const dismissPopup = useCallback(() => {
    setPopup(null);
  }, []);

  // Fully stops everything — used only when there's truly nothing left unacked
  // (i.e. every pending order has been accepted/resolved).
  const stopAll = useCallback(() => {
    unackedRef.current.clear();
    setUnreadCount(0);
    setPopup(null);
    clearInterval(repeatRef.current);
    clearInterval(flashRef.current);
    document.title = "Burger Point Admin";
  }, []);

  useEffect(() => {
    const pending = orders.filter(o => o.status === "pending");

    // On first load, seed prevIds without notifying — orders already
    // pending before admin logged in are not "new" to this session.
    if (isFirstLoadRef.current) {
      prevIdsRef.current = new Set(pending.map(o => o.id));
      isFirstLoadRef.current = false;
      return;
    }

    const newOrders = pending.filter(o => !prevIdsRef.current.has(o.id));

    if (newOrders.length > 0) {
      newOrders.forEach(o => unackedRef.current.add(o.id));
      const count = unackedRef.current.size;
      setUnreadCount(count);
      setPopup(newOrders[0]);

      // Sound immediately
      playChime();

      // Browser notification + tab flash — desktop only
      if (!isMobile) {
        if ("Notification" in window && Notification.permission === "granted") {
          const o = newOrders[0];
          const n = new Notification("🍔 New Order — Burger Point", {
            body: `${o.table_label || o.customer_name || "Customer"} · ₹${o.total}`,
            tag: "bp-order", renotify: true,
          });
          setTimeout(() => n.close(), 7000);
        }
        startFlash(count);
      }

      // Repeat every 15s while unacked
      clearInterval(repeatRef.current);
      repeatRef.current = setInterval(() => {
        if (unackedRef.current.size > 0) { playChime(); if (!isMobile) startFlash(unackedRef.current.size); }
        else { clearInterval(repeatRef.current); }
      }, 15000);
    }

    // Remove orders that are no longer pending (accepted/served) from unacked
    const pendingIds = new Set(pending.map(o => o.id));
    let changed = false;
    unackedRef.current.forEach(id => {
      if (!pendingIds.has(id)) { unackedRef.current.delete(id); changed = true; }
    });
    if (changed) {
      const n = unackedRef.current.size;
      setUnreadCount(n);
      if (n === 0) stopAll();
    }

    prevIdsRef.current = new Set(orders.filter(o => o.status === "pending").map(o => o.id));
  }, [orders, playChime, startFlash, stopAll]);

  // Feature 11: re-alert for stuck pending orders (>5 min) every 60s
  const stuckAlertRef = useRef(null);
  useEffect(() => {
    if (!authed) return;
    stuckAlertRef.current = setInterval(() => {
      const now = Date.now();
      const stuck = orders.filter(o =>
        o.status === "pending" && (now - new Date(o.created_at).getTime()) > 5 * 60 * 1000
      );
      if (stuck.length > 0) {
        playChime();
        if (!isMobile) startFlash(stuck.length);
      }
    }, 60000);
    return () => clearInterval(stuckAlertRef.current);
  }, [orders, authed, playChime, startFlash]);

  useEffect(() => () => {
    clearInterval(repeatRef.current);
    clearInterval(flashRef.current);
    document.title = "Burger Point Admin";
    audioCtxRef.current?.close().catch(() => {});
  }, []);

  const acknowledge = useCallback(() => dismissPopup(), [dismissPopup]);
  return { popup, unreadCount, acknowledge };
}

// ─────────────────────────────────────────────────────────
//  ADMIN APP (root)
// ─────────────────────────────────────────────────────────
export default function AdminApp() {
  const [authed,          setAuthed]          = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [orders,          setOrders]          = useState([]);
  const [loading,         setLoading]         = useState(false);
  const [online,          setOnline]          = useState(false);
  const [filter,          setFilter]          = useState("all");
  const [typeFilter,      setTypeFilter]      = useState("all");
  const [tab,             setTab]             = useState("orders");
  const [riders,          setRiders]          = useState(() => { try { return JSON.parse(localStorage.getItem("bp_riders") || "[]"); } catch { return []; } }); // Supabase sync happens in SettingsTab
  const [assignModal,     setAssignModal]     = useState(null);
  const [reservations,    setReservations]    = useState([]);
  const [resvFilter,      setResvFilter]      = useState("pending"); // "pending"|"all"
  const { popup: newOrderPopup, unreadCount, acknowledge } = useOrderNotifications(orders, authed);
  const [busyConfirm, setBusyConfirm] = useState(false);
  const [busy,        setBusy]        = useState({ is_busy: false, message: "We are currently closed. Please check back later.", opens_at: "" });
  const [busySaving,  setBusySaving]  = useState(false);

  // ── Business settings ──
  const { settings: bizSettings } = useBusinessSettings();
  const toast = useToast();

  const normaliseAll = useCallback(data => data.map(normalise), []);

  const fetchOrders = useCallback(async () => {
    if (!SUPABASE_READY) return;
    setLoading(true);
    // Limit to today's orders only — fetching all historical orders every poll
    // is the single biggest egress driver. Sales/history tab queries separately.
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { data, error } = await supabase
      .from("orders")
      .select("id,created_at,status,order_type,table_label,customer_name,customer_phone,items,total,note,payment_method,delivery_address,customer_lat,customer_lng,rider_name,rider_phone,rider_id,rider_status,route_distance_km,route_eta_minutes,delivery_started_at,cancel_reason,cancelled_at,promo_code,discount,pending_addon_items,pending_addon_total,addon_requested_at,route_geometry")
      .gte("created_at", todayStart.toISOString())
      .order("created_at", { ascending: false });
    setLoading(false);
    if (!error && data) { setOrders(normaliseAll(data)); setOnline(true); } else setOnline(false);
  }, [normaliseAll]);

  // ── Supabase Auth session ──────────────────────────────
  useEffect(() => {
    if (!SUPABASE_READY) { setCheckingSession(false); return; }
    supabase.auth.getSession().then(({ data: { session } }) => {
      setAuthed(!!session);
      setCheckingSession(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthed(!!session);
    });
    return () => subscription.unsubscribe();
  }, []);

  // ── Reservations fetch + real-time ──
  useEffect(() => {
    if (!authed || !SUPABASE_READY) return;
    supabase.from("reservations").select("*").order("date").order("time")
      .then(({ data }) => { if (data) setReservations(data); });
    const ch = supabase.channel("admin_reservations")
      .on("postgres_changes", { event: "*", schema: "public", table: "reservations" }, p => {
        if (p.eventType === "INSERT") setReservations(prev => [...prev, p.new].sort((a,b)=>a.date.localeCompare(b.date)||a.time.localeCompare(b.time)));
        else if (p.eventType === "UPDATE") setReservations(prev => prev.map(r => r.id === p.new.id ? p.new : r));
        else if (p.eventType === "DELETE") setReservations(prev => prev.filter(r => r.id !== p.old?.id));
      }).subscribe();
    return () => supabase.removeChannel(ch);
  }, [authed]);

  const updateReservation = async (id, status) => {
    const snapshot = reservations.find(r => r.id === id);
    setReservations(prev => prev.map(r => r.id === id ? { ...r, status } : r));
    const { error } = await supabase.from("reservations").update({ status }).eq("id", id);
    if (error) {
      if (snapshot) setReservations(prev => prev.map(r => r.id === id ? snapshot : r));
      toast.error("⚠️ Couldn't update reservation — " + error.message);
    }
  };

  useEffect(() => {
    if (!authed || !SUPABASE_READY) return;
    fetchOrders();
    // Load busy mode into root state
    supabase.from("busy_mode").select("*").eq("id", 1).single()
      .then(({ data }) => { if (data) setBusy(data); });

    let fallbackTimer = null;
    const clearFallback = () => { if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; } };
    const startFallback = () => {
      if (fallbackTimer) return; // already running
      setOnline(false);
      fallbackTimer = setInterval(() => {
        fetchOrders();
        // Try to reconnect — if fetchOrders succeeds it'll setOnline(true)
      }, 10000);
    };

    const ch = supabase.channel("admin_orders")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, p => {
        if (p.eventType === "INSERT") setOrders(prev => [normalise(p.new), ...prev]);
        else if (p.eventType === "UPDATE") setOrders(prev => prev.map(o => o.id === p.new.id ? normalise(p.new) : o));
        else if (p.eventType === "DELETE") setOrders(prev => prev.filter(o => o.id !== p.old?.id));
      })
      .subscribe((state) => {
        if (state === "SUBSCRIBED") {
          setOnline(true);
          clearFallback();
        } else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT" || state === "CLOSED") {
          startFallback();
        }
      });

    // No constant polling — Realtime handles live updates.
    // Only refetch when the admin comes back to the tab after being away,
    // to catch anything missed while the tab was hidden.
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchOrders();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => { clearFallback(); supabase.removeChannel(ch); document.removeEventListener("visibilitychange", onVisible); };
  }, [authed, fetchOrders]);

  const updateStatus = async (id, status, extra = {}) => {
    // Guard: never push a terminal order forward
    const snapshot = orders.find(o => o.id === id);
    if (snapshot && isOrderTerminal(snapshot)) {
      toast.error("This order is already " + snapshot.status + " — no further changes allowed.");
      return;
    }

    // Optimistic update immediately so UI feels instant
    setOrders(prev => prev.map(o => o.id === id ? { ...o, status, ...extra } : o));
    if (!SUPABASE_READY) return;

    // Only send columns that exist in the orders table to avoid 400 errors.
    // Extra fields like cancel_reason / cancelled_at / rider_name etc. are allowed.
    // Unknown keys from future code won't cause a crash — Supabase ignores them
    // if the column doesn't exist, but it WILL 400 if RLS blocks the update.
    const payload = { status, ...extra };

    const { error } = await supabase.from("orders").update(payload).eq("id", id);
    if (error) {
      // Roll back the optimistic update
      if (snapshot) setOrders(prev => prev.map(o => o.id === id ? snapshot : o));
      console.warn("[bp] updateStatus error:", error?.message);
      if (error.code === "42501" || error.message?.includes("policy")) {
        toast.error("⚠️ Permission denied — run fix_orders_rls.sql in Supabase dashboard.");
      } else if (error.code === "42703" || error.message?.includes("column")) {
        // Unknown column — retry without the extra fields so status still updates
        const { error: retryErr } = await supabase.from("orders").update({ status }).eq("id", id);
        if (retryErr) {
          toast.error("⚠️ Status update failed — check connection and tap Refresh.");
        }
        // Show a warning but don't block — the status did update
        console.warn("[bp] updateStatus: retried with status only");
      } else {
        toast.error("⚠️ Status update failed — check connection and tap Refresh.");
      }
    }
  };

  const handleCancel = async (id, reasonId) => {
    const reason = CANCEL_REASONS.find(r => r.id === reasonId);
    await updateStatus(id, "cancelled", {
      cancel_reason: reason?.label || "Order cancelled",
      cancelled_at: new Date().toISOString(),
    });
    toast.success("Order cancelled — customer has been notified.");
  };

  // ── Printer handlers ──
  const handlePrintKOT = useCallback((order) => {
    try {
      printKOT(order);
      toast.success("🍳 KOT print dialog opened!");
    } catch (e) {
      toast.error("KOT print failed: " + (e.message || e));
    }
  }, [toast]);

  const handlePrintInvoice = useCallback((order) => {
    try {
      printInvoice(order, bizSettings);
      toast.success("🧾 Invoice print dialog opened!");
    } catch (e) {
      toast.error("Invoice print failed: " + (e.message || e));
    }
  }, [bizSettings, toast]);

  // ── Generate road route via OSRM (free, no API key) ──
  const generateRoute = async (order) => {
    try {
      const restLat = 26.926287, restLng = 80.942995; // restaurant coords
      const custLat = order.customer_lat;
      const custLng = order.customer_lng;
      if (!custLat || !custLng) return null;

      const url = `https://router.project-osrm.org/route/v1/driving/${restLng},${restLat};${custLng},${custLat}?overview=full&geometries=geojson`;
      const res  = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      const route = data.routes?.[0];
      if (!route) return null;

      // GeoJSON coords are [lng, lat] — swap to [lat, lng] for Leaflet
      const coords = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      return {
        route_geometry:      coords,
        route_distance_km:   Math.round((route.distance / 1000) * 10) / 10,
        route_eta_minutes:   Math.max(10, Math.ceil(route.duration / 60) + 5), // +5 min buffer
        delivery_started_at: new Date().toISOString(),
      };
    } catch (e) {
      // route generation failed — non-critical
      return null;
    }
  };

  const handleAssign = async (orderId, rider) => {
    if (!rider) return;
    const order = orders.find(o => o.id === orderId);
    const routeData = order ? await generateRoute(order) : null;

    // Only attach rider fields — do NOT advance to "dispatched" here.
    // "dispatched" fires when the rider physically picks up the order
    // and marks it in RiderApp. Admin assigning = rider_status "assigned",
    // order status stays as-is (typically "ready").
    const { error } = await supabase.from("orders").update({
      rider_name:   rider.full_name,
      rider_phone:  rider.phone_number,
      rider_id:     rider.rider_id,
      rider_status: "assigned",
      ...(routeData || {}),
    }).eq("id", orderId);

    if (error) {
      console.warn("[bp] handleAssign error:", error?.message);
      toast.error("⚠️ Rider assignment failed — check connection.");
      return;
    }

    // Optimistic update in local state (mirrors what Supabase just wrote)
    setOrders(prev => prev.map(o =>
      o.id === orderId
        ? { ...o, rider_name: rider.full_name, rider_phone: rider.phone_number, rider_id: rider.rider_id, rider_status: "assigned", ...(routeData || {}) }
        : o
    ));

    // Mark rider as Busy
    const { error: riderErr } = await supabase.from("riders").update({ availability: "Busy", updated_at: new Date().toISOString() }).eq("rider_id", rider.rider_id);
    if (riderErr) console.warn("[bp] rider availability update failed:", riderErr?.message);
    setAssignModal(null);
  };

  const logout = async () => { await supabase.auth.signOut(); setAuthed(false); };

  if (checkingSession) return (
    <div className="bg-gradient-to-br from-stone-900 to-stone-800 flex items-center justify-center" style={{minHeight:"100dvh"}}>
      <RefreshCw size={22} className="text-white animate-spin" />
    </div>
  );

  if (!authed) return <LoginScreen onLogin={() => setAuthed(true)} />;

  // Orders tab shows anything still needing action — including served
  // dine-in/takeaway orders (guest still at table / bill not closed).
  // Only cancelled/completed (and delivered "served") move to Sales as history.
  let filtered = orders.filter(isOrderActive);
  if (filter !== "all")     filtered = filtered.filter(o => o.status === filter);
  if (typeFilter !== "all") filtered = filtered.filter(o => (o.order_type || "dine-in") === typeFilter);

  const pendingCount = orders.filter(o => o.status === "pending").length;
  const displayBadge = unreadCount > 0 ? unreadCount : pendingCount;

  const pendingResvCount = reservations.filter(r => r.status === "pending").length;
  const tabs = [
    { id: "orders",    icon: <ShoppingBag size={16} />,   label: "Orders",    badge: displayBadge || pendingResvCount },
    { id: "tables",    icon: <LayoutGrid size={16} />,    label: "Tables" },
    { id: "billing",   icon: <Printer size={16} />,       label: "Billing" },
    { id: "menu",      icon: <span className="text-base">🍔</span>, label: "Menu" },
    { id: "sales",     icon: <BarChart2 size={16} />,     label: "Sales" },
    { id: "customers", icon: <Users size={16} />,         label: "Customers" },
    { id: "riders",    icon: <Bike size={16} />,          label: "Riders" },
    { id: "settings",  icon: <Settings size={16} />,      label: "Settings" },
  ];

  return (
    <div className="bg-stone-50 flex flex-col" style={{height:"100dvh", overflow: tab === "billing" ? "hidden" : "auto"}}>
      {/* Top bar */}
      <div className="sticky top-0 z-30 bg-white border-b border-stone-100 shadow-sm">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">🍔</span>
            <div>
              <p className="font-black text-stone-800 text-sm leading-tight">Burger Point</p>
              <div className="flex items-center gap-1">
                {online ? <Wifi size={9} className="text-green-500" /> : <WifiOff size={9} className="text-red-400" />}
                <span className={`text-[10px] font-bold ${online ? "text-green-600" : "text-red-500"}`}>{online ? "Live" : "Offline"}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {displayBadge > 0 && (
              <span className="bg-red-500 text-white text-xs font-black px-2 py-0.5 rounded-full animate-pulse">{displayBadge} new</span>
            )}
            {/* 🔴🟢 Open/Closed quick toggle */}
            <button onClick={() => setBusyConfirm(true)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-black text-xs transition-all ${
                busy.is_busy
                  ? "bg-red-100 text-red-600 border border-red-200"
                  : "bg-green-100 text-green-700 border border-green-200"
              }`}>
              <span className="text-[10px]">{busy.is_busy ? "🔴" : "🟢"}</span>
              {busy.is_busy ? "CLOSED" : "OPEN"}
            </button>
            <button onClick={fetchOrders} disabled={loading}
              className="w-8 h-8 rounded-xl bg-stone-100 flex items-center justify-center">
              <RefreshCw size={13} className={`text-stone-500 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {/* ── Open/Closed Confirm Modal ── */}
        {busyConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/50" onClick={() => setBusyConfirm(false)} />
            <div className="relative bg-white rounded-3xl p-6 w-full max-w-xs shadow-2xl text-center">
              <div className="text-5xl mb-3">{busy.is_busy ? "🟢" : "🔴"}</div>
              <p className="font-black text-stone-800 text-lg mb-1">
                {busy.is_busy ? "Reopen Restaurant?" : "Close Restaurant?"}
              </p>
              <p className="text-sm text-stone-500 mb-5">
                {busy.is_busy
                  ? "Customers will be able to place orders again."
                  : "No new orders will come in until you reopen."}
              </p>
              <div className="flex gap-3">
                <button onClick={() => setBusyConfirm(false)}
                  className="flex-1 py-3 rounded-2xl bg-stone-100 text-stone-600 font-black text-sm active:scale-95 transition-all">
                  Cancel
                </button>
                <button onClick={async () => {
                    const newState = !busy.is_busy;
                    setBusy(b => ({ ...b, is_busy: newState }));
                    setBusyConfirm(false);
                    setBusySaving(true);
                    const { error } = await supabase.from("busy_mode").upsert({ id: 1, is_busy: newState, message: busy.message, opens_at: busy.opens_at });
                    setBusySaving(false);
                    if (error) { toast.error("Failed to save — try again"); setBusy(b => ({ ...b, is_busy: !newState })); }
                    else { toast.success(newState ? "🔴 Restaurant closed" : "🟢 Restaurant reopened"); }
                  }}
                  className={`flex-[2] py-3 rounded-2xl font-black text-sm text-white shadow-lg active:scale-95 transition-all ${
                    busy.is_busy ? "bg-green-500" : "bg-red-500"
                  }`}>
                  {busy.is_busy ? "Yes, Reopen" : "Yes, Close"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Tab bar */}
        <div className="flex border-t border-stone-100 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex-1 min-w-[60px] flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-bold transition-all relative ${tab === t.id ? "text-orange-500 border-b-2 border-orange-500" : "text-stone-400"}`}>
              {t.icon}
              {t.label}
              {t.badge > 0 && (
                <span className="absolute top-1.5 right-2 min-w-[16px] h-4 px-0.5 rounded-full bg-red-500 text-white text-[9px] font-black flex items-center justify-center animate-pulse">
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Billing tab — full width, full height POS layout, outside the narrow wrapper */}
      {tab === "billing" && (
        <div className="flex-1 overflow-hidden flex flex-col">
          <BillingTab bizSettings={bizSettings} />
        </div>
      )}

      {/* Main content — all other tabs use narrow centered layout */}
      <div className={tab === "billing" ? "hidden" : "flex-1 max-w-2xl mx-auto w-full px-4 py-4"}>

        {/* ORDERS TAB */}
        {tab === "orders" && (
          <>
            {/* ── RESERVATIONS PANEL ── */}
            {(() => {
              const pendingResvs = reservations.filter(r => r.status === "pending");
              const shownResvs   = resvFilter === "pending" ? pendingResvs : reservations;
              return (
                <div className="mb-5 rounded-3xl overflow-hidden border border-indigo-100 bg-white shadow-sm">
                  <div className="px-4 pt-4 pb-3 flex items-center justify-between"
                    style={{ background: "linear-gradient(135deg,#eef2ff,#e0e7ff)" }}>
                    <div className="flex items-center gap-2">
                      <span className="text-xl">📅</span>
                      <div>
                        <p className="text-sm font-black text-indigo-900">Table Reservations</p>
                        <p className="text-[10px] text-indigo-500 font-bold">
                          {pendingResvs.length > 0 ? `${pendingResvs.length} awaiting confirmation` : "All caught up!"}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      {["pending","all"].map(f=>(
                        <button key={f} onClick={()=>setResvFilter(f)}
                          className={`text-[10px] font-bold px-2.5 py-1 rounded-lg transition-all ${resvFilter===f?"bg-indigo-600 text-white":"bg-white/70 text-indigo-600 border border-indigo-200"}`}>
                          {f==="pending"?"Pending":"All"}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="divide-y divide-stone-50">
                    {shownResvs.length === 0 ? (
                      <p className="text-xs text-stone-400 text-center py-5">
                        {resvFilter === "pending" ? "No pending reservations 🎉" : "No reservations yet"}
                      </p>
                    ) : shownResvs.map(r => (
                      <div key={r.id} className={`px-4 py-3 transition-all ${r.status==="cancelled"?"opacity-40":""}`}>
                        <div className="flex items-start gap-3">
                          <div className="w-9 h-9 rounded-xl flex items-center justify-center text-lg flex-shrink-0"
                            style={{ background: r.status==="confirmed"?"#dcfce7":r.status==="cancelled"?"#fee2e2":"#fef9c3" }}>
                            {r.status==="confirmed"?"✅":r.status==="cancelled"?"❌":"⏳"}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-sm font-bold text-stone-800">{r.name}</p>
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${r.status==="confirmed"?"bg-green-100 text-green-700":r.status==="cancelled"?"bg-red-100 text-red-500":"bg-yellow-100 text-yellow-700"}`}>
                                {r.status}
                              </span>
                            </div>
                            <p className="text-xs text-stone-500 mt-0.5">
                              📅 {r.date} · 🕐 {r.time} · 👥 {r.guests} guests · 📞 {r.phone}
                            </p>
                            {r.note && <p className="text-xs text-stone-400 italic mt-0.5">"{r.note}"</p>}
                            {r.pre_order_items?.length > 0 && (
                              <div className="mt-1.5 bg-orange-50 rounded-xl px-3 py-2 border border-orange-100">
                                <p className="text-[10px] font-black text-orange-600 uppercase tracking-widest mb-1">Pre-ordered Food 🍔</p>
                                <div className="flex flex-wrap gap-1">
                                  {r.pre_order_items.map(i=>(
                                    <span key={i.id} className="text-[10px] bg-orange-100 text-orange-700 font-bold px-2 py-0.5 rounded-lg">
                                      {i.name} ×{i.qty}
                                    </span>
                                  ))}
                                </div>
                                <p className="text-[10px] font-bold text-orange-500 mt-1">
                                  Total: ₹{r.pre_order_items.reduce((s,i)=>s+i.price*i.qty,0)}
                                </p>
                              </div>
                            )}
                            {r.status === "pending" && (
                              <div className="flex gap-2 mt-2">
                                <button onClick={() => updateReservation(r.id, "confirmed")}
                                  className="flex-1 bg-green-500 text-white text-xs font-bold py-2 rounded-xl active:scale-95 transition-transform">
                                  ✓ Confirm Booking
                                </button>
                                <button onClick={() => updateReservation(r.id, "cancelled")}
                                  className="flex-1 bg-stone-100 text-stone-600 text-xs font-bold py-2 rounded-xl active:scale-95 transition-transform">
                                  ✕ Decline
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Filters */}
            <div className="flex gap-2 mb-4 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
              {[
                { id: "all", label: "All" },
                { id: "pending", label: "⏳ Pending" },
                { id: "accepted", label: "👨‍🍳 Preparing" },
                { id: "ready", label: "✅ Ready" },
                { id: "dispatched", label: "🛵 Dispatched" },
              ].map(f => (
                <button key={f.id} onClick={() => setFilter(f.id)}
                  className={`flex-shrink-0 text-xs font-bold px-3 py-1.5 rounded-xl transition-all ${filter === f.id ? "bg-orange-500 text-white" : "bg-white border border-stone-200 text-stone-500"}`}>
                  {f.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2 mb-4 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
              {[
                { id: "all", label: "🍽️ All Types" },
                { id: "dine-in", label: "Dine-In" },
                { id: "takeaway", label: "📦 Takeaway" },
                { id: "delivery", label: "🛵 Delivery" },
              ].map(f => (
                <button key={f.id} onClick={() => setTypeFilter(f.id)}
                  className={`flex-shrink-0 text-xs font-bold px-3 py-1.5 rounded-xl transition-all ${typeFilter === f.id ? "bg-stone-700 text-white" : "bg-white border border-stone-200 text-stone-500"}`}>
                  {f.label}
                </button>
              ))}
            </div>

            {!SUPABASE_READY ? (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-center">
                <p className="text-sm font-bold text-amber-800">Supabase not connected</p>
                <p className="text-xs text-amber-600 mt-1">Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your .env file</p>
              </div>
            ) : loading && orders.length === 0 ? (
              <div className="space-y-1">
                {Array.from({ length: 5 }).map((_, i) => <OrderCardSkeleton key={i} />)}
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-16">
                <p className="text-4xl mb-3">📋</p>
                <p className="text-stone-400 text-sm">No orders {filter !== "all" ? `with status "${filter}"` : "in progress"}</p>
                <p className="text-stone-300 text-xs mt-1">Completed and cancelled orders are in the Sales tab</p>
              </div>
            ) : (
              <>
                {(() => {
                  // Detect tables with multiple active (non-terminal) orders — flag add-ons.
                  // (Real merges now happen at order-placement time — see CustomerApp — so
                  // this is a fallback for any pre-existing split rows.)
                  const activeByTable = {};
                  orders.forEach(o => {
                    if (!o.table_label || !isOrderActive(o)) return;
                    if (!activeByTable[o.table_label]) activeByTable[o.table_label] = [];
                    activeByTable[o.table_label].push(o.id);
                  });
                  const multiOrderTables = new Set(
                    Object.entries(activeByTable).filter(([, ids]) => ids.length > 1).map(([lbl]) => lbl)
                  );
                  return filtered.map(order => (
                    <OrderCard key={order.id} order={order}
                      onAdvance={updateStatus}
                      onCancel={handleCancel}
                      riders={riders}
                      onAssignDispatch={id => setAssignModal(id)}
                      onPrintKOT={handlePrintKOT}
                      onPrintInvoice={handlePrintInvoice}
                      isAddOn={!!order.table_label && multiOrderTables.has(order.table_label)} />
                  ));
                })()}
              </>
            )}
          </>
        )}

        {tab === "tables"    && <TablesTab orders={orders} />}
        {tab === "menu"      && <MenuTab />}
        {tab === "sales"     && <SalesTab />}
        {tab === "customers" && <CustomersTab />}
        {tab === "riders"    && <RidersTab />}
        {tab === "settings"  && <SettingsTab riders={riders} setRiders={setRiders} onLogout={logout} busy={busy} setBusy={setBusy} busySaving={busySaving} setBusySaving={setBusySaving} />}
      </div>

      {/* New order popup */}
      <NewOrderPopup order={newOrderPopup} count={unreadCount} onAck={acknowledge} />

      {/* Assign rider modal */}
      {assignModal && (
        <AssignModal orderId={assignModal} onAssign={handleAssign} onClose={() => setAssignModal(null)} />
      )}
    </div>
  );
}

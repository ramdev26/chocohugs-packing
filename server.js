require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const path    = require('path');

const app = express();

const {
  SHOPIFY_STORE,
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  HOST = 'http://localhost:3000',
} = process.env;

if (!SHOPIFY_STORE || !SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
  console.error('ERROR: SHOPIFY_STORE, SHOPIFY_API_KEY, and SHOPIFY_API_SECRET must be set in .env');
  process.exit(1);
}

// Token held in memory; survives requests but resets on restart.
// On Railway, set SHOPIFY_ACCESS_TOKEN env var to skip re-auth after restarts.
let ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getProp(properties, ...keys) {
  if (!Array.isArray(properties)) return '';
  for (const key of keys) {
    const hit = properties.find(p => p.name.toLowerCase() === key.toLowerCase());
    if (hit) return hit.value || '';
  }
  return '';
}

function cleanRibbon(val) {
  if (!val) return 'No';
  return val.toLowerCase().startsWith('yes') ? 'Yes' : 'No';
}

function cleanCard(val) {
  if (!val) return 'None';
  const l = val.toLowerCase().trim();
  if (l === 'none' || l === '' || l === 'no') return 'None';
  return val.trim();
}

function packingSummary(row) {
  const parts = [row['Order Number'], `Qty: ${row['Quantity']}`, row['Product Name']];
  if (row['Variant']) parts[2] += ` (${row['Variant']})`;
  if (row['Greeting Card'] !== 'None') parts.push(`Card: ${row['Greeting Card']}`);
  parts.push(`Ribbon: ${row['Ribbon & Bow']}`);
  if (row['Personal Message']) parts.push(`Msg: ${row['Personal Message']}`);
  return parts.join(' | ');
}

function ordersToRows(orders) {
  const rows = [];
  const knownKeys = new Set(['greeting card', 'ribbon & bow', 'ribbon', 'personal message', 'message', 'note']);

  for (const order of orders) {
    const orderNote = (order.note || '').trim();
    const orderDate = new Date(order.created_at).toLocaleDateString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
    });
    const customer = order.shipping_address
      ? `${order.shipping_address.first_name || ''} ${order.shipping_address.last_name || ''}`.trim()
      : (order.email || '');

    for (const item of order.line_items) {
      const props = item.properties || [];
      const greetingCard = cleanCard(getProp(props, 'Greeting Card', 'greeting card'));
      const ribbon       = cleanRibbon(getProp(props, 'Ribbon & Bow', 'ribbon & bow', 'ribbon'));
      const message      = getProp(props, 'Personal Message', 'personal message', 'message', 'note') || orderNote;

      const otherProps = props
        .filter(p => !knownKeys.has(p.name.toLowerCase()) && !p.name.startsWith('_'))
        .filter(p => p.value && !['none', 'no', ''].includes(p.value.toLowerCase()))
        .map(p => `${p.name}: ${p.value}`)
        .join(' | ');

      const row = {
        'Order Number':       `#${order.order_number}`,
        'Order Date':         orderDate,
        'Customer':           customer,
        'Product Name':       item.title,
        'Variant':            item.variant_title || '',
        'SKU':                item.sku || '',
        'Quantity':           item.quantity,
        'Greeting Card':      greetingCard,
        'Ribbon & Bow':       ribbon,
        'Personal Message':   message,
        'Other Add-ons':      otherProps,
        'Fulfillment Status': order.fulfillment_status || 'unfulfilled',
      };
      row['Packing Summary'] = packingSummary(row);
      rows.push(row);
    }
  }
  return rows;
}

async function fetchAllOrders({ startDate, endDate, fulfillmentStatus }) {
  const allOrders = [];
  let pageInfo = null;

  while (true) {
    const query = new URLSearchParams({ limit: '250' });

    if (pageInfo) {
      query.set('page_info', pageInfo);
    } else {
      query.set('status', 'any');
      if (fulfillmentStatus && fulfillmentStatus !== 'any') {
        query.set('fulfillment_status', fulfillmentStatus);
      }
      if (startDate) query.set('created_at_min', `${startDate}T00:00:00`);
      if (endDate)   query.set('created_at_max', `${endDate}T23:59:59`);
      query.set('fields', [
        'id', 'order_number', 'created_at', 'note',
        'email', 'financial_status', 'fulfillment_status',
        'shipping_address', 'line_items',
      ].join(','));
    }

    const url = `https://${SHOPIFY_STORE}/admin/api/2025-01/orders.json?${query}`;
    const res = await axios.get(url, {
      headers: { 'X-Shopify-Access-Token': ACCESS_TOKEN },
    });

    allOrders.push(...(res.data.orders || []));

    const link      = res.headers['link'] || '';
    const nextMatch = link.match(/<[^>]+[?&]page_info=([^>&"]+)[^>]*>;\s*rel="next"/);
    if (nextMatch) pageInfo = nextMatch[1]; else break;
  }

  return allOrders;
}

function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc  = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return '﻿' + [
    headers.map(esc).join(','),
    ...rows.map(r => headers.map(h => esc(r[h])).join(',')),
  ].join('\r\n');
}

// ── OAuth ─────────────────────────────────────────────────────────────────────

app.get('/auth', (_req, res) => {
  const redirectUri = `${HOST}/auth/callback`;
  const state       = crypto.randomBytes(12).toString('hex');

  const url = 'https://' + SHOPIFY_STORE + '/admin/oauth/authorize?' + new URLSearchParams({
    client_id:    SHOPIFY_API_KEY,
    scope:        'read_orders',
    redirect_uri: redirectUri,
    state,
  });

  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, hmac } = req.query;
  if (!code || !hmac) return res.status(400).send('Missing parameters');

  // Validate HMAC
  const params  = Object.fromEntries(Object.entries(req.query).filter(([k]) => k !== 'hmac'));
  const message = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const digest  = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(message).digest('hex');
  if (digest !== hmac) return res.status(403).send('HMAC validation failed');

  try {
    const { data } = await axios.post(
      `https://${SHOPIFY_STORE}/admin/oauth/access_token`,
      { client_id: SHOPIFY_API_KEY, client_secret: SHOPIFY_API_SECRET, code }
    );

    ACCESS_TOKEN = data.access_token;
    console.log('OAuth complete. Access token obtained.');

    // Show the token so it can be saved as an env var for persistence
    res.send(`<!DOCTYPE html><html><head><title>Connected</title>
<style>
  body{font-family:-apple-system,sans-serif;max-width:560px;margin:60px auto;padding:20px;color:#202223}
  h2{margin-bottom:8px}
  .box{background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:20px;margin:16px 0}
  code{display:block;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:10px;
       font-size:13px;word-break:break-all;margin:8px 0;font-family:monospace}
  .btn{display:inline-block;background:#008060;color:#fff;padding:10px 20px;border-radius:6px;
       text-decoration:none;font-weight:600;margin-top:16px}
  p{font-size:14px;line-height:1.6;color:#444}
  .note{font-size:12px;color:#6d7175;margin-top:8px}
</style></head><body>
<h2>✅ Connected to Shopify!</h2>
<div class="box">
  <p><strong>Save this token in Railway → Variables to avoid re-authentication after restarts:</strong></p>
  <code>SHOPIFY_ACCESS_TOKEN = ${ACCESS_TOKEN}</code>
  <p class="note">The app is already working this session. Adding it to Railway makes it permanent.</p>
</div>
<a href="/" class="btn">Open Packing Report →</a>
</body></html>`);
  } catch (e) {
    console.error('OAuth error:', e.response?.data || e.message);
    res.status(500).send('OAuth failed — check your Client ID and Secret are correct in Railway variables.');
  }
});

// ── API middleware: require token ─────────────────────────────────────────────

function requireToken(req, res, next) {
  if (ACCESS_TOKEN) return next();
  res.status(401).json({ error: 'not_authenticated' });
}

// ── API routes ────────────────────────────────────────────────────────────────

app.get('/api/orders', requireToken, async (req, res) => {
  try {
    const orders = await fetchAllOrders(req.query);
    const rows   = ordersToRows(orders);
    res.json({
      rows,
      stats: {
        orderCount: orders.length,
        rowCount:   rows.length,
        withCard:   rows.filter(r => r['Greeting Card'] !== 'None').length,
        withRibbon: rows.filter(r => r['Ribbon & Bow']  === 'Yes').length,
      },
    });
  } catch (e) {
    const msg = e.response?.data?.errors || e.message;
    console.error('API error:', msg);
    res.status(500).json({ error: String(msg) });
  }
});

app.get('/api/export', requireToken, async (req, res) => {
  try {
    const orders = await fetchAllOrders(req.query);
    const rows   = ordersToRows(orders);
    if (!rows.length) return res.status(404).json({ error: 'No orders found.' });

    const filename = `packing-report-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(toCSV(rows));
  } catch (e) {
    const msg = e.response?.data?.errors || e.message;
    console.error('Export error:', msg);
    res.status(500).json({ error: String(msg) });
  }
});

app.get('/health', (_req, res) =>
  res.json({ ok: true, store: SHOPIFY_STORE, authenticated: !!ACCESS_TOKEN })
);

// ── Static files (served after API routes) ────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Choco Hugs Packing Report → http://localhost:${PORT}`)
);

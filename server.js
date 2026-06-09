require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

if (!STORE || !TOKEN) {
  console.error('ERROR: SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN must be set in .env');
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  const lower = val.toLowerCase().trim();
  if (lower === 'none' || lower === '' || lower === 'no') return 'None';
  return val.trim();
}

function packingSummary(row) {
  const parts = [
    row['Order Number'],
    `Qty: ${row['Quantity']}`,
    row['Product Name'] + (row['Variant'] ? ` (${row['Variant']})` : ''),
  ];
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

      const greetingCard = cleanCard(
        getProp(props, 'Greeting Card', 'greeting card')
      );
      const ribbon = cleanRibbon(
        getProp(props, 'Ribbon & Bow', 'ribbon & bow', 'ribbon')
      );
      const message = getProp(props, 'Personal Message', 'personal message', 'message', 'note')
        || orderNote;

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

// ── Shopify API ───────────────────────────────────────────────────────────────

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

    const url = `https://${STORE}/admin/api/2025-01/orders.json?${query}`;
    const res = await axios.get(url, {
      headers: { 'X-Shopify-Access-Token': TOKEN },
    });

    allOrders.push(...(res.data.orders || []));

    const link = res.headers['link'] || '';
    const nextMatch = link.match(/<[^>]+[?&]page_info=([^>&"]+)[^>]*>;\s*rel="next"/);
    if (nextMatch) {
      pageInfo = nextMatch[1];
    } else {
      break;
    }
  }

  return allOrders;
}

// ── CSV builder ───────────────────────────────────────────────────────────────

function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [
    headers.map(esc).join(','),
    ...rows.map(r => headers.map(h => esc(r[h])).join(',')),
  ];
  return '﻿' + lines.join('\r\n'); // BOM for Excel UTF-8
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/orders', async (req, res) => {
  try {
    const orders = await fetchAllOrders(req.query);
    const rows   = ordersToRows(orders);

    const withCard   = rows.filter(r => r['Greeting Card'] !== 'None').length;
    const withRibbon = rows.filter(r => r['Ribbon & Bow'] === 'Yes').length;

    res.json({
      rows,
      stats: {
        orderCount: orders.length,
        rowCount:   rows.length,
        withCard,
        withRibbon,
      },
    });
  } catch (e) {
    const msg = e.response?.data?.errors || e.message;
    console.error('API error:', msg);
    res.status(500).json({ error: String(msg) });
  }
});

app.get('/api/export', async (req, res) => {
  try {
    const orders = await fetchAllOrders(req.query);
    const rows   = ordersToRows(orders);

    if (!rows.length) {
      return res.status(404).json({ error: 'No orders found for the selected filters.' });
    }

    const csv      = toCSV(rows);
    const filename = `packing-report-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (e) {
    const msg = e.response?.data?.errors || e.message;
    console.error('Export error:', msg);
    res.status(500).json({ error: String(msg) });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, store: STORE }));

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Choco Hugs Packing Report running at http://localhost:${PORT}`)
);

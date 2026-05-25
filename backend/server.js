// ===== Load .env =====
(function loadEnv() {
  const fs = require('fs');
  const p = require('path');
  const envPath = p.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(function(line) {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf('=');
    if (idx === -1) return;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  });
})();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== P2: Structured Logger ==========
function log(level, ...args) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level}]`;
  if (level === 'ERROR') {
    console.error(prefix, ...args);
  } else if (level === 'WARN') {
    console.warn(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }
}

// ========== Security headers (Helmet) ==========
app.use(helmet());

// CSP
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "https://mc.yandex.ru"],
    imgSrc: ["'self'", "data:", "https://mc.yandex.ru"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    connectSrc: ["'self'"],
  }
}));

// CORS — restrict to frontend origin
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

// Hide framework info
app.disable('x-powered-by');

// P2: Request body size limit
app.use(express.json({ limit: '10kb' }));

// ========== P1: Rate Limiting for payment routes ==========
let paymentRateLimiter = null;
try {
  const rateLimit = require('express-rate-limit');
  paymentRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    message: { error: 'Too many payment requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  log('INFO', 'express-rate-limit loaded for /api/payment/*');
} catch (e) {
  log('WARN', 'express-rate-limit not installed. Run: npm install express-rate-limit');
}

if (paymentRateLimiter) {
  app.use('/api/payment', paymentRateLimiter);
}

// ========== P1: CSRF protection (Origin/Referer check) ==========
const CSRF_EXEMPT_PATHS = [
  '/api/payment/yookassa/callback',
  '/api/payment/yookassa/create',
  '/api/payment/create',
  '/health'
];
function csrfProtection(req, res, next) {
  if (req.method === 'GET') return next();
  if (CSRF_EXEMPT_PATHS.some(p => req.path.startsWith(p))) return next();

  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const allowedOrigin = process.env.FRONTEND_URL || 'http://localhost:3000';

  // 开发环境放宽检查
  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev) {
    log('WARN', 'CSRF check disabled in development');
    return next();
  }

  const isValid = (origin && origin === allowedOrigin) ||
    (referer && referer.startsWith(allowedOrigin));

  if (!isValid) {
    log('WARN', `CSRF failed: origin=${origin}, referer=${referer}, allowed=${allowedOrigin}`);
    return res.status(403).json({ error: 'CSRF validation failed' });
  }
  next();
}
app.use(csrfProtection);

// ========== P1: /health endpoint ==========
const startTime = Date.now();
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

// Serve static frontend
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));

// Load services data
let servicesData = [];
try {
  const dataPath = path.join(__dirname, 'data', 'services.json');
  servicesData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  log('INFO', `Loaded ${servicesData.length} service categories`);
} catch (e) {
  log('ERROR', 'Failed to load services.json:', e.message);
}

// API: Get all services
app.get('/api/services', (req, res) => {
  res.json(servicesData);
});

// API: Search services
app.get('/api/services/search', (req, res) => {
  const query = (req.query.q || '').toLowerCase();
  if (!query) return res.json(servicesData);

  const filtered = servicesData.map(cat => {
    const filteredSubs = cat.subcategories.map(sub => ({
      ...sub,
      services: (sub.services || []).filter(s => {
        const text = JSON.stringify(s).toLowerCase();
        return text.includes(query);
      })
    })).filter(sub => sub.services.length > 0);

    return { ...cat, subcategories: filteredSubs };
  }).filter(cat => cat.subcategories.length > 0);

  res.json(filtered);
});

// ========== YooKassa Integration ==========
// P0: Read keys from environment variables
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY;
const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID;

if (!YOOKASSA_SECRET_KEY || !YOOKASSA_SHOP_ID) {
  log('ERROR', 'YOOKASSA_SECRET_KEY and YOOKASSA_SHOP_ID must be set in .env');
  throw new Error('Missing YooKassa credentials. Set YOOKASSA_SECRET_KEY and YOOKASSA_SHOP_ID environment variables.');
}

const { YooKassaSdk } = require('@exode-team/yokassa.api');

const yookassa = new YooKassaSdk({
  secret_key: YOOKASSA_SECRET_KEY,
  shop_id: YOOKASSA_SHOP_ID,
  debug: true,
});

const paymentsFile = path.join(__dirname, 'data', 'payments.json');

function loadPayments() {
  try { return JSON.parse(fs.readFileSync(paymentsFile, 'utf-8')); }
  catch { return []; }
}
function savePayments(data) {
  fs.writeFileSync(paymentsFile, JSON.stringify(data, null, 2), 'utf-8');
}

// ========== P2: Input validation helpers ==========
function validateAmount(amount) {
  if (amount === undefined || amount === null) return 'Amount is required';
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    return 'Amount must be a positive integer';
  }
  if (n > 10000000) return 'Amount exceeds maximum allowed (10,000,000)';
  return null;
}

function validateDescription(desc) {
  if (desc === undefined || desc === null) return null; // optional
  if (typeof desc !== 'string') return 'Description must be a string';
  if (desc.length > 500) return 'Description must be 500 characters or fewer';
  return null;
}

// ========== P0: Simplified /api/payment/create (no simulation) ==========
app.post('/api/payment/create', (req, res) => {
  const { amount, description } = req.body;

  const amountErr = validateAmount(amount);
  if (amountErr) return res.status(400).json({ error: amountErr });

  const descErr = validateDescription(description);
  if (descErr) return res.status(400).json({ error: descErr });

  const payments = loadPayments();
  const order = {
    id: 'ORD-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    amount: parseInt(amount, 10),
    description: description || '',
    status: 'pending',
    createdAt: new Date().toISOString(),
    paidAt: null
  };
  payments.push(order);
  savePayments(payments);

  res.json(order);
});

// Order status
app.get('/api/payment/status', (req, res) => {
  const { orderId } = req.query;
  const payments = loadPayments();
  const order = payments.find(p => p.id === orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// List orders
app.get('/api/payment/orders', (req, res) => {
  res.json(loadPayments().reverse());
});

// ========== YooKassa Real Payments ==========

// Create payment via YooKassa
app.post('/api/payment/yookassa/create', async (req, res) => {
  try {
    const { amount, description, returnUrl } = req.body;

    const amountErr = validateAmount(amount);
    if (amountErr) return res.status(400).json({ error: amountErr });

    const descErr = validateDescription(description);
    if (descErr) return res.status(400).json({ error: descErr });

    const payment = await yookassa.payments.create({
      amount: { value: String(amount), currency: 'RUB' },
      confirmation: {
        type: 'redirect',
        return_url: returnUrl || 'https://chongwuyuyue.onrender.com/payment-result.html',
      },
      description: description || 'Оплата услуг ветеринарной клиники',
      capture: true,
    });

    // Save to local database with yookassa_id
    const localOrder = {
      id: 'ORD-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      yookassa_id: payment.id,
      amount: parseInt(amount, 10),
      description: description || '',
      status: payment.status,
      createdAt: new Date().toISOString(),
      confirmationUrl: payment.confirmation?.confirmation_url,
    };
    const payments = loadPayments();
    payments.push(localOrder);
    savePayments(payments);

    res.json({
      id: payment.id,
      status: payment.status,
      confirmationUrl: payment.confirmation?.confirmation_url,
      localOrderId: localOrder.id,
    });
  } catch (err) {
    log('ERROR', '[YooKassa] Payment creation error:', err.message);
    res.status(500).json({ error: 'Ошибка создания платежа', details: err.message });
  }
});

// ========== P0: Webhook IP whitelist for YooKassa callback ==========
function ipToNumber(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function ipInRange(ip, range) {
  if (!range.includes('/')) {
    return ip === range;
  }
  const [network, bitsStr] = range.split('/');
  const bits = parseInt(bitsStr, 10);
  const mask = (~0 << (32 - bits)) >>> 0;
  const ipNum = ipToNumber(ip);
  const netNum = ipToNumber(network);
  return (ipNum & mask) === (netNum & mask);
}

const YOOKASSA_WEBHOOK_IPS = [
  '185.71.76.0/27', '185.71.77.0/27', '77.75.153.0/25',
  '77.75.156.11', '77.75.156.35', '77.75.154.128/25',
];

function isYooKassaIp(clientIp) {
  if (!clientIp) return false;
  // Normalize IPv6-mapped IPv4
  const ip = clientIp.replace(/^::ffff:/, '');
  return YOOKASSA_WEBHOOK_IPS.some(range => ipInRange(ip, range));
}

// P0: HMAC signature verification helper
function verifyWebhookSignature(req) {
  const secret = process.env.YOOKASSA_WEBHOOK_SECRET;
  if (!secret) {
    log('WARN', 'YOOKASSA_WEBHOOK_SECRET not set — skipping HMAC verification');
    return true; // Allow if not configured; log warning
  }
  const signature = req.headers['yookassa-signature'];
  if (!signature) {
    log('WARN', '[YooKassa] Missing webhook signature header');
    return false;
  }
  try {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(JSON.stringify(req.body));
    const expected = hmac.digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (e) {
    log('ERROR', '[YooKassa] HMAC verification error:', e.message);
    return false;
  }
}

// YooKassa Webhook
app.post('/api/payment/yookassa/callback', (req, res) => {
  try {
    // P0: IP whitelist check
    const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    if (!isYooKassaIp(clientIp)) {
      log('WARN', `[YooKassa] Webhook from unauthorized IP: ${clientIp}`);
      return res.status(403).json({ result: 'forbidden' });
    }

    // P0: HMAC signature verification
    if (!verifyWebhookSignature(req)) {
      log('WARN', '[YooKassa] Webhook signature verification failed');
      return res.status(403).json({ result: 'forbidden' });
    }

    const { event, object } = req.body;

    if (event === 'payment.succeeded' && object?.status === 'succeeded') {
      const payments = loadPayments();
      const idx = payments.findIndex(p => p.yookassa_id === object.id || p.id === object.id);
      if (idx !== -1) {
        payments[idx].status = 'succeeded';
        payments[idx].paidAt = new Date().toISOString();
        savePayments(payments);
        log('INFO', `[YooKassa] Payment ${object.id} confirmed`);
      }
    }

    if (event === 'payment.canceled') {
      const payments = loadPayments();
      const idx = payments.findIndex(p => p.yookassa_id === object.id || p.id === object.id);
      if (idx !== -1) {
        payments[idx].status = 'canceled';
        savePayments(payments);
      }
    }

    res.status(200).json({ result: 'ok' });
  } catch (err) {
    log('ERROR', '[YooKassa] Webhook error:', err.message);
    res.status(200).json({ result: 'ok' });
  }
});

// Check YooKassa payment status
app.get('/api/payment/yookassa/status/:id', async (req, res) => {
  try {
    const payment = await yookassa.payments.load(req.params.id);
    res.json({
      id: payment.id,
      status: payment.status,
      amount: payment.amount,
      description: payment.description,
      paid: payment.paid,
      createdAt: payment.created_at,
    });
  } catch (err) {
    log('ERROR', '[YooKassa] Status check error:', err.message);
    res.status(500).json({ error: 'Ошибка проверки статуса' });
  }
});

// Sync payment status (for result page, when webhook missed)
app.post('/api/payment/sync-status/:id', async (req, res) => {
  try {
    const payment = await yookassa.payments.load(req.params.id);

    const payments = loadPayments();
    const idx = payments.findIndex(p => p.yookassa_id === req.params.id || p.id === req.params.id);
    if (idx !== -1) {
      payments[idx].status = payment.status === 'succeeded' ? 'succeeded' : payment.status;
      if (payment.status === 'succeeded' && !payments[idx].paidAt) {
        payments[idx].paidAt = payment.captured_at || new Date().toISOString();
      }
      savePayments(payments);
    }

    res.json({ id: payment.id, status: payment.status, synced: true });
  } catch (err) {
    log('ERROR', '[YooKassa] Sync error:', err.message);
    res.status(500).json({ error: 'Ошибка синхронизации' });
  }
});

// SPA fallback with CSP nonce injection
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  const indexPath = path.join(frontendPath, 'index.html');
  try {
    let html = fs.readFileSync(indexPath, 'utf-8');
    res.send(html);
  } catch (e) {
    log('ERROR', 'Failed to serve index.html:', e.message);
    res.status(500).send('Internal Server Error');
  }
});

// ========== P1: Global error handler ==========
app.use((err, req, res, next) => {
  log('ERROR', 'Unhandled error:', err.message, err.stack?.split('\n')[0] || '');
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
    ...(process.env.NODE_ENV !== 'production' && { details: err.message }),
  });
});

// ========== P2: Graceful shutdown ==========
const server = app.listen(PORT, () => {
  log('INFO', `Server running on port ${PORT}`);
});

let isShuttingDown = false;

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('INFO', `Received ${signal}, shutting down gracefully...`);

  server.close(() => {
    log('INFO', 'HTTP server closed');
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    log('ERROR', 'Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
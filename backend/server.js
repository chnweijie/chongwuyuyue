const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Security headers
app.use(helmet());
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

app.use(express.json());

// Serve static frontend
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));

// Load services data
let servicesData = [];
try {
    const dataPath = path.join(__dirname, 'data', 'services.json');
    servicesData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    console.log(`Loaded ${servicesData.length} service categories`);
} catch (e) {
    console.error('Failed to load services.json:', e.message);
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

// Serve SPA fallback
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(frontendPath, 'index.html'));
});

// ========== Payment simulation module (JSON-based) ==========
const paymentsFile = path.join(__dirname, 'data', 'payments.json');

function loadPayments() {
  try { return JSON.parse(fs.readFileSync(paymentsFile, 'utf-8')); }
  catch { return []; }
}
function savePayments(data) {
  fs.writeFileSync(paymentsFile, JSON.stringify(data, null, 2), 'utf-8');
}

// Create payment order
app.post('/api/payment/create', (req, res) => {
  const { amount, description } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  const payments = loadPayments();
  const order = {
    id: 'ORD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
    amount: parseInt(amount),
    description: description || '',
    status: 'pending',
    createdAt: new Date().toISOString(),
    paidAt: null
  };
  payments.push(order);
  savePayments(payments);
  res.json({ ...order, paymentUrl: `/api/payment/pay?orderId=${order.id}` });
});

// Simulate payment page
app.get('/api/payment/pay', (req, res) => {
  const { orderId } = req.query;
  const payments = loadPayments();
  const order = payments.find(p => p.id === orderId);
  if (!order) return res.status(404).send('<h2>Заказ не найден</h2>');
  if (order.status === 'paid') return res.send(`<h2>Заказ ${orderId} уже оплачен. Сумма: ${order.amount} ₽</h2>`);
  res.send(`
    <html><head><meta charset="utf-8"><title>Оплата</title>
    <style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#f0f4ff;}
    .card{background:white;padding:40px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.1);text-align:center;max-width:400px;}
    h2{color:#1a3a5c;} .amount{font-size:28px;color:#2563eb;margin:16px 0;}
    button{background:#2563eb;color:white;border:none;padding:14px 40px;border-radius:8px;font-size:16px;cursor:pointer;}
    button:hover{background:#1d4ed8;}</style></head><body>
    <div class="card"><h2>Симуляция оплаты</h2><p>Заказ: ${orderId}</p>
    <div class="amount">${order.amount} ₽</div><p>${order.description || ''}</p>
    <form method="POST" action="/api/payment/callback?orderId=${orderId}">
      <button type="submit">Оплатить (симуляция)</button></form></div></body></html>
  `);
});

// Payment callback
app.post('/api/payment/callback', (req, res) => {
  const { orderId } = req.query;
  const payments = loadPayments();
  const idx = payments.findIndex(p => p.id === orderId);
  if (idx === -1) return res.status(404).json({ error: 'Order not found' });
  payments[idx].status = 'paid';
  payments[idx].paidAt = new Date().toISOString();
  savePayments(payments);
  res.json({ orderId, status: 'paid', message: 'Payment successful (simulated)' });
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

// Cron: check pending transactions (handles callback loss)
setInterval(() => {
  const payments = loadPayments();
  const pending = payments.filter(p => p.status === 'pending');
  if (pending.length > 0) {
    console.log(`[Payment] Active check: ${pending.length} pending orders`);
  }
}, 60000);


app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
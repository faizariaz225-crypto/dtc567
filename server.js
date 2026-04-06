const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const fs         = require('fs');
const path       = require('path');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY      = process.env.ADMIN_KEY || 'dtc2024';
const DATA_DIR          = path.join(__dirname, 'data');
const TOKENS_FILE       = path.join(DATA_DIR, 'tokens.json');
const SESSIONS_FILE     = path.join(DATA_DIR, 'sessions.txt');
const EMAIL_CONFIG      = path.join(DATA_DIR, 'emailConfig.json');
const EMAIL_LOG         = path.join(DATA_DIR, 'emailLog.json');
const PRODUCTS_FILE     = path.join(DATA_DIR, 'products.json');
const INSTRUCTIONS_FILE    = path.join(DATA_DIR, 'instructions.json');
const INSTR_SETS_FILE      = path.join(DATA_DIR, 'instructionSets.json');
const LINK_EXPIRY_MS    = 180 * 24 * 60 * 60 * 1000; // 6 months

const DEFAULT_PRODUCTS = [
  { id: 'claude-pro-1m',  name: 'Claude Pro — 1 Month',   days: 30  },
  { id: 'claude-pro-3m',  name: 'Claude Pro — 3 Months',  days: 90  },
  { id: 'claude-pro-6m',  name: 'Claude Pro — 6 Months',  days: 180 },
  { id: 'claude-pro-1y',  name: 'Claude Pro — 1 Year',    days: 365 },
  { id: 'groksuper-1m',   name: 'GrokSuper — 1 Month',    days: 30  },
  { id: 'groksuper-3m',   name: 'GrokSuper — 3 Months',   days: 90  },
  { id: 'groksuper-6m',   name: 'GrokSuper — 6 Months',   days: 180 },
  { id: 'groksuper-1y',   name: 'GrokSuper — 1 Year',     days: 365 },
  { id: 'custom',         name: 'Custom Package',          days: 30  },
];

const DEFAULT_INSTRUCTIONS = {
  beforeApproval: `1. Open claude.ai and sign in to your account.\n2. Click your profile icon in the bottom-left corner of the screen.\n3. Select Settings, then click on Account.\n4. Your Organization ID is displayed in UUID format (e.g. 714fe120-d7yd-4da9-bb53-84c42f10wac7).`,
  afterApproval:  `1. Open claude.ai and sign in to your account.\n2. Click your profile icon in the bottom-left corner.\n3. Navigate to Settings → Billing.\n4. Your plan should now display as Claude Pro with an active status.\n5. You can confirm by starting a conversation — Pro users have access to Claude Opus and extended usage limits.`
};

if (!fs.existsSync(DATA_DIR))          fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(TOKENS_FILE))       fs.writeFileSync(TOKENS_FILE,  JSON.stringify({}));
if (!fs.existsSync(SESSIONS_FILE))     fs.writeFileSync(SESSIONS_FILE,'');
if (!fs.existsSync(EMAIL_CONFIG))      fs.writeFileSync(EMAIL_CONFIG, JSON.stringify({}));
if (!fs.existsSync(EMAIL_LOG))         fs.writeFileSync(EMAIL_LOG,    JSON.stringify([]));
if (!fs.existsSync(PRODUCTS_FILE))     fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(DEFAULT_PRODUCTS, null, 2));
if (!fs.existsSync(INSTRUCTIONS_FILE)) fs.writeFileSync(INSTRUCTIONS_FILE, JSON.stringify(DEFAULT_INSTRUCTIONS, null, 2));
if (!fs.existsSync(INSTR_SETS_FILE))    fs.writeFileSync(INSTR_SETS_FILE,    JSON.stringify([], null, 2));

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function loadTokens()   { return JSON.parse(fs.readFileSync(TOKENS_FILE,  'utf8')); }
function saveTokens(t)  { fs.writeFileSync(TOKENS_FILE,  JSON.stringify(t, null, 2)); }
function loadEmailCfg() { return JSON.parse(fs.readFileSync(EMAIL_CONFIG, 'utf8')); }
function saveEmailCfg(c){ fs.writeFileSync(EMAIL_CONFIG, JSON.stringify(c, null, 2)); }
function loadEmailLog() { return JSON.parse(fs.readFileSync(EMAIL_LOG,    'utf8')); }
function saveEmailLog(l){ fs.writeFileSync(EMAIL_LOG,    JSON.stringify(l, null, 2)); }
function loadProducts()  { return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8')); }
function saveProducts(p) { fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(p, null, 2)); }
function loadInstructions()  { return JSON.parse(fs.readFileSync(INSTRUCTIONS_FILE, 'utf8')); }
function saveInstructions(i)    { fs.writeFileSync(INSTRUCTIONS_FILE, JSON.stringify(i, null, 2)); }
function loadInstrSets()        { return JSON.parse(fs.readFileSync(INSTR_SETS_FILE, 'utf8')); }
function saveInstrSets(sets)    { fs.writeFileSync(INSTR_SETS_FILE, JSON.stringify(sets, null, 2)); }
function isAdmin(k)     { return k === ADMIN_KEY; }

function getDurationDays(pkg) {
  // First check custom products list
  const products = loadProducts();
  const found = products.find(p => p.name === pkg);
  if (found && found.days) return found.days;
  // Fallback legacy logic
  const p = (pkg||'').toLowerCase();
  if (p.includes('1 year') || p.includes('12 month')) return 365;
  if (p.includes('6 month')) return 180;
  if (p.includes('3 month')) return 90;
  return 30;
}

// ── Nodemailer ────────────────────────────────────────────────────────────────
function buildTransporter() {
  const cfg  = loadEmailCfg();
  if (!cfg.host || !cfg.user || !cfg.pass) return null;
  const port = parseInt(cfg.port) || 587;
  return nodemailer.createTransport({
    host: cfg.host, port,
    secure: port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 15000,
    greetingTimeout:   10000,
    socketTimeout:     15000,
    tls: { rejectUnauthorized: false }
  });
}

async function sendEmail({ to, subject, html, type, token }) {
  const cfg = loadEmailCfg();
  if (!cfg.host || !cfg.user || !cfg.pass)
    return { ok: false, error: 'Email is not configured. Go to Email Config in the admin panel.' };
  const transporter = buildTransporter();
  try {
    await transporter.verify();
    await transporter.sendMail({
      from: `"${cfg.fromName || 'DTC Digital Tools Corner'}" <${cfg.user}>`,
      to, subject, html
    });
    const log = loadEmailLog();
    log.push({ sentAt: new Date().toISOString(), to, subject, type, token: token || null });
    saveEmailLog(log);
    return { ok: true };
  } catch (err) {
    let msg = err.message || 'Unknown error';
    if (msg.includes('ECONNREFUSED'))  msg = `Connection refused on ${cfg.host}:${cfg.port}. Check host and port.`;
    if (msg.includes('ETIMEDOUT') || msg.includes('timeout')) msg = `Connection timed out. If using Gmail, use an App Password (not your regular password) on port 587.`;
    if (msg.includes('ENOTFOUND'))     msg = `Host "${cfg.host}" not found. Check the SMTP host address.`;
    if (msg.includes('535') || msg.includes('auth')) msg = 'Authentication failed. For Gmail, use an App Password.';
    return { ok: false, error: msg };
  }
}

// ── Email templates ───────────────────────────────────────────────────────────
function baseEmail(body) {
  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
    <div style="background:#2563eb;padding:24px 32px">
      <div style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-.02em">DTC</div>
      <div style="font-size:11px;color:rgba(255,255,255,.7);margin-top:2px">Digital Tools Corner</div>
    </div>
    <div style="padding:32px;background:#ffffff">${body}</div>
    <div style="padding:20px 32px;background:#f8faff;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8">
      DTC — Digital Tools Corner &nbsp;·&nbsp; This is an automated notification.
    </div>
  </div>`;
}

function reminderTemplate({ customerName, packageType, expiryDate, daysLeft }) {
  return baseEmail(`
    <div style="font-size:12px;color:#2563eb;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Subscription Reminder</div>
    <h2 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 16px">Your subscription expires in ${daysLeft} day${daysLeft!==1?'s':''}</h2>
    <p style="font-size:14px;color:#64748b;line-height:1.7;margin:0 0 20px">Hi ${customerName}, your <strong style="color:#1e293b">${packageType}</strong> subscription with DTC expires soon. Please renew to maintain uninterrupted access.</p>
    <div style="background:#f8faff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px"><span style="color:#64748b">Package</span><span style="color:#1e293b;font-weight:600">${packageType}</span></div>
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px"><span style="color:#64748b">Expiry Date</span><span style="color:#d97706;font-weight:600">${expiryDate}</span></div>
      <div style="display:flex;justify-content:space-between;font-size:13px"><span style="color:#64748b">Days Remaining</span><span style="color:#d97706;font-weight:600">${daysLeft} day${daysLeft!==1?'s':''}</span></div>
    </div>
    <p style="font-size:13px;color:#94a3b8">Contact us on WeChat or reply to this email to renew your subscription.</p>`);
}

function expiredTemplate({ customerName, packageType }) {
  return baseEmail(`
    <div style="font-size:12px;color:#dc2626;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Subscription Expired</div>
    <h2 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 16px">Your subscription has ended</h2>
    <p style="font-size:14px;color:#64748b;line-height:1.7;margin:0 0 20px">Hi ${customerName}, your <strong style="color:#1e293b">${packageType}</strong> subscription has expired. Renew now to restore access to your Claude Pro features.</p>
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px 18px;margin-bottom:20px">
      <div style="font-size:13px;color:#dc2626;font-weight:600">⚠ Access has ended — ${packageType}</div>
    </div>
    <p style="font-size:13px;color:#94a3b8">Contact us on WeChat or reply to this email to renew.</p>`);
}

// ── Scheduled email check (hourly) ────────────────────────────────────────────
async function checkSubscriptionEmails() {
  const cfg = loadEmailCfg();
  if (!cfg.host || !cfg.user || !cfg.pass) return;
  const tokens = loadTokens();
  const now    = new Date();
  let changed  = false;

  for (const [token, t] of Object.entries(tokens)) {
    if (!t.approved || !t.subscriptionExpiresAt || !t.email) continue;
    const expiry   = new Date(t.subscriptionExpiresAt);
    const daysLeft = Math.ceil((expiry - now) / (1000*60*60*24));

    if (daysLeft === 5 && !t.reminder5Sent) {
      const r = await sendEmail({
        to: t.email,
        subject: `Your Claude subscription expires in 5 days — DTC`,
        html: reminderTemplate({ customerName: t.customerName, packageType: t.packageType, expiryDate: expiry.toLocaleDateString('en-GB',{day:'2-digit',month:'long',year:'numeric'}), daysLeft: 5 }),
        type: 'reminder_5d', token
      });
      if (r.ok) { tokens[token].reminder5Sent = true; changed = true; }
    }

    if (daysLeft <= 0 && !t.expiredEmailSent) {
      const r = await sendEmail({
        to: t.email,
        subject: `Your Claude subscription has expired — DTC`,
        html: expiredTemplate({ customerName: t.customerName, packageType: t.packageType }),
        type: 'expired', token
      });
      if (r.ok) { tokens[token].expiredEmailSent = true; changed = true; }
    }
  }
  if (changed) saveTokens(tokens);
}

setInterval(checkSubscriptionEmails, 60*60*1000);
setTimeout(checkSubscriptionEmails, 30000);

// ── Generate link ─────────────────────────────────────────────────────────────
app.post('/admin/generate', (req, res) => {
  const { adminKey, customerName, packageType, instrSetId } = req.body;
  if (!isAdmin(adminKey)) return res.status(401).json({ error: 'Unauthorized' });
  if (!customerName || !packageType) return res.status(400).json({ error: 'Customer name and package are required.' });
  const token     = uuidv4();
  const tokens    = loadTokens();
  const expiresAt = new Date(Date.now() + LINK_EXPIRY_MS).toISOString();
  tokens[token] = { customerName, packageType, instrSetId: instrSetId||null, createdAt: new Date().toISOString(), expiresAt, used: false, approved: false, declined: false };
  saveTokens(tokens);
  const link = `${req.protocol}://${req.get('host')}/submit?token=${token}`;
  res.json({ link, token, expiresAt });
});

// ── Validate token ────────────────────────────────────────────────────────────
app.get('/api/validate-token', (req, res) => {
  const { token } = req.query;
  const tokens = loadTokens();
  if (!token || !tokens[token]) return res.status(404).json({ valid: false, error: 'This activation link is invalid. Please contact support.' });
  const t = tokens[token];

  // Track access
  const entry = { at: new Date().toISOString(), ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown', userAgent: req.headers['user-agent'] || 'unknown' };
  if (!t.accessLog) t.accessLog = [];
  t.accessLog.push(entry);
  t.firstAccessedAt = t.firstAccessedAt || entry.at;
  t.lastAccessedAt  = entry.at;
  t.accessCount     = (t.accessCount || 0) + 1;
  saveTokens(tokens);

  // Determine if this product uses session field
  const products = loadProducts();
  const product  = products.find(p => p.name === t.packageType);
  const useSessionField = !!(product && product.useSessionField);

  if (t.deactivated) return res.status(403).json({ valid: false, error: 'This activation link has been deactivated by the administrator. Please contact support.' });
  if (t.declined) return res.json({ valid: true, declined: true, declineReason: t.declineReason || '', customerName: t.customerName, packageType: t.packageType });
  if (t.used)     return res.json({ valid: true, submitted: true, approved: t.approved || false, approvedAt: t.approvedAt || null, customerName: t.customerName, packageType: t.packageType, orgId: t.orgId||'', wechat: t.wechat||'', email: t.email||'', sessionDetails: t.sessionDetails||'', useSessionField, subscriptionExpiresAt: t.subscriptionExpiresAt||null });
  // Only block unsubmitted links that have passed the 6-month window
  if (!t.used && t.expiresAt && new Date() > new Date(t.expiresAt)) return res.status(410).json({ valid: false, error: 'This activation link has expired. Please contact support for a new link.' });
  // Resolve instruction set
  const instrSets = loadInstrSets();
  const instrSet  = instrSets.find(s => s.id === t.instrSetId) || null;
  const beforeApproval = instrSet ? instrSet.beforeApproval : (loadInstructions().beforeApproval || '');
  const afterApproval  = instrSet ? instrSet.afterApproval  : (loadInstructions().afterApproval  || '');
  res.json({ valid: true, submitted: false, customerName: t.customerName, packageType: t.packageType, useSessionField, beforeApproval, afterApproval });
});

// ── Submit ────────────────────────────────────────────────────────────────────
app.post('/api/submit', (req, res) => {
  const { token, orgId, wechat, email, sessionDetails } = req.body;
  const tokens = loadTokens();
  if (!token || !tokens[token]) return res.status(404).json({ success: false, error: 'Invalid link.' });
  const t = tokens[token];
  if (t.declined) return res.status(410).json({ success: false, error: 'This request has been declined.' });
  if (t.used)     return res.status(410).json({ success: false, error: 'Details already submitted.' });
  // Only block submission if the link window has expired AND the token has never been used
  if (!t.used && t.expiresAt && new Date() > new Date(t.expiresAt)) return res.status(410).json({ success: false, error: 'This link has expired.' });

  // Determine field mode from product config
  const products = loadProducts();
  const product  = products.find(p => p.name === t.packageType);
  const useSessionField = !!(product && product.useSessionField);

  const UUID_REGEX  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const errors = {};

  if (useSessionField) {
    if (!sessionDetails || !sessionDetails.trim()) {
      errors.sessionDetails = 'Session details are required.';
    } else {
      try {
        const parsed = JSON.parse(sessionDetails.trim());
        const planType  = (parsed.planType  || '').toLowerCase();
        const structure = (parsed.structure || '').toLowerCase();
        if (!planType || !structure) errors.sessionDetails = 'Session details must contain planType and structure fields.';
        else if (planType !== 'free') errors.sessionDetails = `Invalid plan: "${parsed.planType}". Only Free plan accounts are accepted.`;
        else if (structure !== 'personal') errors.sessionDetails = `Invalid structure: "${parsed.structure}". Only Personal accounts are accepted.`;
      } catch(e) {
        errors.sessionDetails = 'Session details must be valid JSON. Please copy the exact text provided.';
      }
    }
  } else {
    if (!orgId || !UUID_REGEX.test(orgId.trim()))  errors.orgId  = 'Invalid Organization ID format.';
  }
  if (!wechat || !wechat.trim())                 errors.wechat = 'WeChat ID is required.';
  if (!email  || !EMAIL_REGEX.test(email.trim())) errors.email  = 'Please enter a valid email address.';
  if (Object.keys(errors).length) return res.status(400).json({ success: false, errors });

  const timestamp = new Date().toISOString();
  const detailLine = useSessionField ? `Session Details  : ${sessionDetails.trim()}` : `Organization ID  : ${orgId ? orgId.trim() : ''}`;
  const entry = ['══════════════════════════════════════════════════════',`Submitted At     : ${timestamp}`,`Customer         : ${t.customerName}`,`Package          : ${t.packageType}`,'── Details ────────────────────────────────────────────',detailLine,`WeChat           : ${wechat.trim()}`,`Email            : ${email.trim()}`,'══════════════════════════════════════════════════════',''].join('\n');
  fs.appendFileSync(SESSIONS_FILE, entry);
  tokens[token].used = true; tokens[token].submittedAt = timestamp;
  tokens[token].wechat = wechat.trim(); tokens[token].email = email.trim();
  if (useSessionField) tokens[token].sessionDetails = sessionDetails.trim();
  else tokens[token].orgId = orgId ? orgId.trim() : '';
  saveTokens(tokens);
  res.json({ success: true });
});

// ── Poll status ───────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const { token } = req.query;
  const tokens = loadTokens();
  if (!token || !tokens[token]) return res.status(404).json({ error: 'Invalid.' });
  const t = tokens[token];
  res.json({
    status: t.declined ? 'declined' : t.approved ? 'activated' : t.used ? 'processing' : 'pending',
    packageType: t.packageType, customerName: t.customerName,
    approvedAt: t.approvedAt||null, declineReason: t.declineReason||'',
    orgId: t.orgId||'', wechat: t.wechat||'', email: t.email||'',
    sessionDetails: t.sessionDetails||'',
    subscriptionExpiresAt: t.subscriptionExpiresAt||null
  });
});

// ── Admin: approve ────────────────────────────────────────────────────────────
app.post('/admin/approve', (req, res) => {
  const { adminKey, token } = req.body;
  if (!isAdmin(adminKey)) return res.status(401).json({ error: 'Unauthorized' });
  const tokens = loadTokens();
  if (!tokens[token]) return res.status(404).json({ error: 'Not found.' });
  if (tokens[token].approved) return res.json({ success: true });
  const days  = getDurationDays(tokens[token].packageType);
  tokens[token].approved = true;
  tokens[token].declined = false;
  tokens[token].approvedAt = new Date().toISOString();
  tokens[token].subscriptionExpiresAt = new Date(Date.now() + days*24*60*60*1000).toISOString();
  tokens[token].subscriptionDays = days;
  saveTokens(tokens);
  res.json({ success: true });
});

// ── Admin: decline ────────────────────────────────────────────────────────────
app.post('/admin/decline', (req, res) => {
  const { adminKey, token, reason } = req.body;
  if (!isAdmin(adminKey)) return res.status(401).json({ error: 'Unauthorized' });
  const tokens = loadTokens();
  if (!tokens[token]) return res.status(404).json({ error: 'Not found.' });
  tokens[token].declined     = true;
  tokens[token].approved     = false;
  tokens[token].declinedAt   = new Date().toISOString();
  tokens[token].declineReason= reason || 'The details provided could not be verified. Please check your Organization ID and try again.';
  saveTokens(tokens);
  res.json({ success: true });
});

// ── Admin: sessions data ──────────────────────────────────────────────────────
app.post('/admin/sessions-data', (req, res) => {
  const { adminKey } = req.body;
  if (!isAdmin(adminKey)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ tokens: loadTokens(), emailLog: loadEmailLog() });
});

// ── Admin: email config ───────────────────────────────────────────────────────
app.post('/admin/email-config', (req, res) => {
  const { adminKey, config } = req.body;
  if (!isAdmin(adminKey)) return res.status(401).json({ error: 'Unauthorized' });
  saveEmailCfg(config);
  res.json({ success: true });
});
app.get('/admin/email-config', (req, res) => {
  if (!isAdmin(req.query.adminKey)) return res.status(401).json({ error: 'Unauthorized' });
  const cfg = loadEmailCfg();
  res.json({ ...cfg, pass: cfg.pass ? '••••••••' : '' });
});
app.post('/admin/test-email', async (req, res) => {
  const { adminKey, to } = req.body;
  if (!isAdmin(adminKey)) return res.status(401).json({ error: 'Unauthorized' });
  const r = await sendEmail({ to, subject: 'DTC — Test Email', html: baseEmail(`<h2 style="color:#1e293b">✓ Email is working!</h2><p style="color:#64748b;margin-top:12px">Your DTC email configuration is set up correctly.</p>`), type: 'test' });
  res.json(r);
});
app.post('/admin/send-reminder', async (req, res) => {
  const { adminKey, token, type } = req.body;
  if (!isAdmin(adminKey)) return res.status(401).json({ error: 'Unauthorized' });
  const tokens = loadTokens();
  const t = tokens[token];
  if (!t || !t.email) return res.status(400).json({ error: 'No email on record.' });
  const expiry   = t.subscriptionExpiresAt ? new Date(t.subscriptionExpiresAt) : null;
  const daysLeft = expiry ? Math.ceil((expiry - new Date())/(1000*60*60*24)) : 0;
  const expiryStr= expiry ? expiry.toLocaleDateString('en-GB',{day:'2-digit',month:'long',year:'numeric'}) : '—';
  const html     = type==='expired' ? expiredTemplate({ customerName:t.customerName, packageType:t.packageType }) : reminderTemplate({ customerName:t.customerName, packageType:t.packageType, expiryDate:expiryStr, daysLeft });
  const subject  = type==='expired' ? `Your Claude subscription has expired — DTC` : `Subscription reminder — expires in ${daysLeft} days — DTC`;
  res.json(await sendEmail({ to: t.email, subject, html, type:'manual_'+type, token }));
});

// ── Products ──────────────────────────────────────────────────────────────────
app.get('/admin/products', (req, res) => {
  if (!isAdmin(req.query.adminKey)) return res.status(401).json({ error: 'Unauthorized' });
  res.json(loadProducts());
});
app.post('/admin/products', (req, res) => {
  const { adminKey, products } = req.body;
  if (!isAdmin(adminKey)) return res.status(401).json({ error: 'Unauthorized' });
  if (!Array.isArray(products)) return res.status(400).json({ error: 'Invalid data.' });
  saveProducts(products);
  res.json({ success: true });
});

// ── Instructions ──────────────────────────────────────────────────────────────
app.get('/admin/instructions', (req, res) => {
  if (!isAdmin(req.query.adminKey)) return res.status(401).json({ error: 'Unauthorized' });
  res.json(loadInstructions());
});
app.post('/admin/instructions', (req, res) => {
  const { adminKey, instructions } = req.body;
  if (!isAdmin(adminKey)) return res.status(401).json({ error: 'Unauthorized' });
  if (!instructions || typeof instructions !== 'object') return res.status(400).json({ error: 'Invalid data.' });
  saveInstructions(instructions);
  res.json({ success: true });
});

// Public endpoint for form to fetch instructions
app.get('/api/instructions', (req, res) => {
  res.json(loadInstructions());
});

// Public endpoint for form to fetch products (so form knows product name display)
app.get('/api/products', (req, res) => {
  res.json(loadProducts());
});

// ── Instruction Sets ─────────────────────────────────────────────────────────
app.get('/admin/instruction-sets', (req, res) => {
  if (!isAdmin(req.query.adminKey)) return res.status(401).json({ error: 'Unauthorized' });
  res.json(loadInstrSets());
});
app.post('/admin/instruction-sets', (req, res) => {
  const { adminKey, sets } = req.body;
  if (!isAdmin(adminKey)) return res.status(401).json({ error: 'Unauthorized' });
  if (!Array.isArray(sets)) return res.status(400).json({ error: 'Invalid data.' });
  saveInstrSets(sets);
  res.json({ success: true });
});

// Public: return all instruction sets (form uses token's instrSetId to pick the right one)
app.get('/api/instruction-sets', (req, res) => {
  res.json(loadInstrSets());
});

// ── Admin: deactivate / reactivate link ───────────────────────────────────────
app.post('/admin/deactivate', (req, res) => {
  const { adminKey, token, deactivate } = req.body;
  if (!isAdmin(adminKey)) return res.status(401).json({ error: 'Unauthorized' });
  const tokens = loadTokens();
  if (!tokens[token]) return res.status(404).json({ error: 'Not found.' });
  tokens[token].deactivated = !!deactivate;
  tokens[token].deactivatedAt = deactivate ? new Date().toISOString() : null;
  saveTokens(tokens);
  res.json({ success: true });
});

// ── Pages ─────────────────────────────────────────────────────────────────────
app.get('/submit', (req, res) => res.sendFile(path.join(__dirname, 'public', 'form.html')));
app.get('/admin',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.listen(PORT, () => {
  console.log(`\n✅  DTC — Digital Tools Corner`);
  console.log(`🌐  http://localhost:${PORT}\n`);
});

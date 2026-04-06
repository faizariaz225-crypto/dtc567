# QuickPlus Session Portal

A secure link-based customer session submission system.
Customers fill in their account details via a unique one-time link you generate.
All submissions are saved to `data/sessions.txt` on your server.

---

## How It Works

1. **You** open `/admin`, enter your admin key, fill in the customer name + package, and click **Generate Unique Link**.
2. **You share that link** with the customer (WhatsApp, email, etc.).
3. **Customer opens the link**, fills in their Email, Username, and Password with live validation.
4. Details are saved to `data/sessions.txt` and the link is marked as used (single-use).
5. Customer sees a confirmation: *"Your package will be activated shortly."*

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Set your admin key (optional but recommended)
Edit `server.js` and replace `'quickplus2024'` with a strong secret, or set an environment variable:
```bash
export ADMIN_KEY="your-secret-key-here"
```

### 3. Start the server
```bash
node server.js
```

The server starts on **port 3000** by default.
Set `PORT` environment variable to change it:
```bash
PORT=8080 node server.js
```

---

## Deployment (VPS / shared hosting)

### Using PM2 (recommended for 24/7 uptime)
```bash
npm install -g pm2
pm2 start server.js --name "session-portal"
pm2 save
pm2 startup
```

### Nginx reverse proxy config (put behind your domain)
```nginx
server {
    listen 80;
    server_name portal.quickplus.vip;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Then add SSL with: `certbot --nginx -d portal.quickplus.vip`

---

## URL Structure

| URL | Purpose |
|-----|---------|
| `/admin` | Your admin panel (generate links, view sessions) |
| `/submit?token=UUID` | Customer-facing form (unique per customer) |

---

## Validation Rules

| Field | Rules |
|-------|-------|
| Email | Must be valid format (user@example.com) |
| Username | 3–20 chars, letters/numbers/underscores only |
| Password | 8+ chars, 1 uppercase, 1 number, 1 special char (@$!%*?&_-#) |
| Confirm Password | Must match password |

---

## Data Storage

- **`data/tokens.json`** — Stores all generated tokens and their status (used/unused)
- **`data/sessions.txt`** — All submitted customer details in readable format

---

## Security Notes

- Change the default admin key (`quickplus2024`) before going live.
- Each link is **single-use** — once submitted, it can't be used again.
- Run behind HTTPS in production (use Nginx + Let's Encrypt / Certbot).
- Do not expose the `/admin` endpoint publicly — restrict via IP or add HTTP basic auth.

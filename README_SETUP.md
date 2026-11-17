# On-Farm — Complete SaaS Setup Guide

Yeh guide On-Farm SaaS ecosystem ko setup karne ke 3 simple steps samjhati hai:

---

## Step 1: Supabase Me Tables Create Karein (Sirf 1 Minute)

1. Apne **Supabase Dashboard** me jayein (jo project aapne abhi banaya hai: `on-farm-backend`).
2. Left sidebar me **SQL Editor** (terminal icon) par click karein.
3. Click karein **"+ New query"**.
4. Project me bani file **`database/schema.sql`** ka pura code copy karein aur wahan paste kar dein.
5. Bottom-right me **"Run"** button dabayein.
   * `Success. No rows returned` message aayega. Aapke saare tables (`users`, `wallets`, `subscriptions`, `transactions`, `remote_scripts`, `app_config`) create ho jayenge!

---

## Step 2: `server/.env` Me Keys Daalein

`server/.env` file kholein aur yeh keys paste karein:

```env
PORT=4000
ADMIN_SECRET_KEY=Npneeraj@2754

# 1. Supabase (Supabase -> Project Settings (gear icon) -> API)
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJh...... (service_role secret key)

# 2. Cashfree (Cashfree Dashboard -> Developers -> API Keys)
CASHFREE_ENV=PRODUCTION
CASHFREE_APP_ID=your_cashfree_app_id
CASHFREE_SECRET_KEY=your_cashfree_secret_key

# 3. Security Key (Koi bhi 32 akshar ki key ya default rehne dein)
SCRIPT_ENCRYPTION_SECRET=onfarm_super_secure_secret_key32
```

Keys daalne ke baad ek baar yeh command chalayein taaki automation script cloud me publish ho jaye:
```powershell
node server/publish-core-script.js
```

---

## Step 3: Kaise Chalayein?

* **Admin Panel & Backend Chalane Ke Liye:**
  Double-click karein: **`run-server.bat`**
  * Backend port 4000 par start hoga aur aapka **Master Admin Dashboard** browser me automatically khul jayega!
  * Yahan se aap sabhi users ke wallets, subscriptions, device lock (HWID) reset aur 1-click update manage kar sakte hain.

* **Client / Operator Automation Chalane Ke Liye:**
  Double-click karein: **`run-client.bat`**
  * Hardware ID verify hogi, internet check hoga, aur **http://localhost:3789** par clean Control Panel khulega jahan se operator ₹1/kila recharge ya ₹699 pass le sakega aur START daba kar automation chala sakega.

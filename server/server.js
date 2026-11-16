// server/server.js
// Main backend server for On-Farm SaaS

const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const cashfree = require('./cashfree');
const { encryptScript, decryptScript } = require('./security');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Handle Vercel Express rewrites
app.use((req, res, next) => {
  const forwardedPath = req.headers['x-matched-path'] || req.headers['x-invoke-path'];
  if (forwardedPath && req.url === '/server.js') {
    req.url = forwardedPath;
  }
  next();
});
app.all('/server.js', (req, res, next) => {
  const forwardedPath = req.headers['x-matched-path'] || req.headers['x-invoke-path'] || '/api/health';
  req.url = forwardedPath;
  app.handle(req, res, next);
});

// Serve Admin Dashboard
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});
app.get('/', (req, res) => {
  res.redirect('/admin');
});

// Initialize Supabase Client
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase configuration missing in .env (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required)');
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// -------------------------------------------------------------------------
// 1. PUBLIC & RUNNER CLIENT ENDPOINTS
// -------------------------------------------------------------------------

/**
 * Health Check (Used for mandatory "Bina Internet Kahi Na Chale" check)
 */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    status: 'ONLINE',
    server_time: new Date().toISOString(),
    service: 'On-Farm Cloud License Server',
  });
});

/**
 * Version Gate & Remote Config
 */
app.get('/api/config', async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.from('app_config').select('key, value');
    if (error) throw error;

    const configMap = {};
    (data || []).forEach(row => { configMap[row.key] = row.value; });

    res.json({
      ok: true,
      config: configMap,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Device HWID Status Check
 * Automatically recognizes if this physical computer is already bound to an operator
 */
app.post('/api/auth/device-status', async (req, res) => {
  const { hwid } = req.body;
  if (!hwid) {
    return res.status(400).json({ ok: false, message: 'hwid is required' });
  }

  try {
    const supabase = getSupabase();
    const { data: user, error } = await supabase
      .from('users')
      .select('*, wallets(*), subscriptions(*)')
      .eq('hwid', hwid)
      .maybeSingle();

    if (error) throw error;

    if (!user) {
      return res.json({ ok: true, bound: false, message: 'Device not yet bound to any operator.' });
    }

    if (user.is_blocked) {
      return res.status(403).json({
        ok: false,
        code: 'USER_BLOCKED',
        message: 'This device account has been blocked by Admin.',
      });
    }

    const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', user.id).maybeSingle();
    const { data: subs } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .gt('expires_at', new Date().toISOString())
      .order('expires_at', { ascending: false })
      .maybeSingle();

    res.json({
      ok: true,
      bound: true,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        hwid: user.hwid,
      },
      wallet: {
        balance: Number(wallet ? wallet.balance : 0),
        total_recharged: wallet ? wallet.total_recharged : 0,
        total_kilas: wallet ? wallet.total_kilas_processed : 0,
      },
      subscription: subs ? {
        plan: subs.plan_name,
        expires_at: subs.expires_at,
        is_active: true,
      } : null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * User Login + HWID Device Locking
 */
app.post('/api/auth/login', async (req, res) => {
  const { phone, name, hwid, email } = req.body;
  if (!phone || !hwid) {
    return res.status(400).json({ ok: false, message: 'Phone number and HWID are required' });
  }

  const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);

  try {
    const supabase = getSupabase();

    // Check if this computer (HWID) is already registered to a DIFFERENT phone number
    const { data: existingHwidUsers } = await supabase
      .from('users')
      .select('id, phone, name')
      .eq('hwid', hwid);

    const otherUserOnThisDevice = (existingHwidUsers || []).find(u => u.phone !== cleanPhone);
    if (otherUserOnThisDevice) {
      return res.status(403).json({
        ok: false,
        code: 'HWID_ALREADY_BOUND',
        message: `This application profile is registered to +91 ${otherUserOnThisDevice.phone}. Please contact Administrator for profile transfer.`,
      });
    }

    // Check if user exists
    let { data: user, error } = await supabase
      .from('users')
      .select('*, wallets(*), subscriptions(*)')
      .eq('phone', cleanPhone)
      .maybeSingle();

    if (error) throw error;

    if (!user) {
      // Auto-register new user — permanently binds HWID to this device!
      const { data: newUser, error: createErr } = await supabase
        .from('users')
        .insert([{
          phone: cleanPhone,
          name: name || `Operator_${cleanPhone.slice(-4)}`,
          email: email || '',
          hwid: hwid, // First login permanently binds HWID to this device!
        }])
        .select('*, wallets(*), subscriptions(*)')
        .single();

      if (createErr) throw createErr;
      user = newUser;
    } else {
      // User exists — check blocked status
      if (user.is_blocked) {
        return res.status(403).json({
          ok: false,
          code: 'USER_BLOCKED',
          message: 'Aapka account block kiya gaya hai. Kripya Admin se sampark karein.',
        });
      }

      // Enforce HWID Device Lock
      if (!user.hwid) {
        // First device binding
        await supabase.from('users').update({ hwid, last_active_at: new Date() }).eq('id', user.id);
        user.hwid = hwid;
      } else if (user.hwid !== hwid) {
        return res.status(403).json({
          ok: false,
          code: 'HWID_MISMATCH',
          message: 'This account is already active on another installation. Please contact Administrator for assistance.',
        });
      } else {
        await supabase.from('users').update({ last_active_at: new Date() }).eq('id', user.id);
      }
    }

    // Refresh wallet and active subscription details
    const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', user.id).maybeSingle();
    const { data: subs } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .gt('expires_at', new Date().toISOString())
      .order('expires_at', { ascending: false })
      .maybeSingle();

    const hasActiveSubscription = !!subs;
    const walletBalance = Number(wallet ? wallet.balance : 0);

    res.json({
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        hwid: user.hwid,
      },
      wallet: {
        balance: walletBalance,
        total_recharged: wallet ? wallet.total_recharged : 0,
        total_kilas: wallet ? wallet.total_kilas_processed : 0,
      },
      subscription: subs ? {
        plan: subs.plan_name,
        expires_at: subs.expires_at,
        is_active: true,
      } : null,
      can_execute: hasActiveSubscription || walletBalance >= 1.00,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// -------------------------------------------------------------------------
// 2. CASHFREE PAYMENTS (₹1/KILA WALLET & ₹699/MONTH SUBSCRIPTION)
// -------------------------------------------------------------------------

/**
 * Creates a Cashfree payment order
 * type: 'SUBSCRIPTION_699' | 'WALLET_RECHARGE'
 */
app.post('/api/pay/create-order', async (req, res) => {
  const { userId, type, customAmount, returnUrl } = req.body;
  if (!userId || !type) {
    return res.status(400).json({ ok: false, message: 'userId and type are required' });
  }

  let amount = 699.00;
  let orderNote = 'On-Farm 30-Day Unlimited Subscription Pass';

  if (type === 'WALLET_RECHARGE') {
    amount = Math.max(1.00, Number(customAmount || 1.00));
    orderNote = `On-Farm Wallet Recharge: ₹${amount}`;
  }

  try {
    const supabase = getSupabase();
    const { data: user, error: userErr } = await supabase.from('users').select('*').eq('id', userId).single();
    if (userErr || !user) throw new Error('User not found');

    const prefix = type === 'SUBSCRIPTION_699' ? 'PASS' : 'WAL';
    const cleanPhone = String(user.phone || 'OPERATOR').replace(/\D/g, '').slice(-10);
    const timeCode = Date.now().toString(36).toUpperCase();
    const randCode = Math.floor(1000 + Math.random() * 9000);
    const orderId = `ONFARM_${prefix}_${cleanPhone}_${timeCode}${randCode}`;

    // Call Cashfree API
    const orderData = await cashfree.createOrder({
      orderId,
      orderAmount: amount,
      customerId: user.id,
      customerPhone: cleanPhone,
      customerName: user.name || 'Valued Farmer / Operator',
      orderNote,
      returnUrl,
    });

    // Record pending transaction in Supabase
    await supabase.from('transactions').insert([{
      user_id: user.id,
      amount,
      type: type === 'SUBSCRIPTION_699' ? 'SUBSCRIPTION_699' : 'WALLET_RECHARGE',
      cashfree_order_id: orderId,
      payment_session_id: orderData.payment_session_id,
      status: 'PENDING',
      details: orderData,
    }]);

    res.json({
      ok: true,
      order_id: orderId,
      payment_session_id: orderData.payment_session_id,
      amount,
      orderData,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Verifies payment order status with Cashfree and updates user balance/subscription
 */
app.post('/api/pay/verify', async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ ok: false, message: 'orderId is required' });

  try {
    const supabase = getSupabase();
    const orderData = await cashfree.getOrderStatus(orderId);

    if (orderData.order_status === 'PAID') {
      const { data: tx, error: txErr } = await supabase
        .from('transactions')
        .select('*')
        .eq('cashfree_order_id', orderId)
        .single();

      if (txErr || !tx) throw new Error('Transaction record not found');

      if (tx.status !== 'SUCCESS') {
        // Mark transaction as SUCCESS
        await supabase.from('transactions').update({ status: 'SUCCESS' }).eq('id', tx.id);

        if (tx.type === 'SUBSCRIPTION_699') {
          // Activate 30-day subscription
          const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          await supabase.from('subscriptions').insert([{
            user_id: tx.user_id,
            plan_name: 'MONTHLY_699',
            expires_at: expiresAt,
            is_active: true,
          }]);
        } else if (tx.type === 'WALLET_RECHARGE') {
          // Increment wallet balance
          const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', tx.user_id).single();
          const newBal = Number(wallet ? wallet.balance : 0) + Number(tx.amount);
          const newRecharged = Number(wallet ? wallet.total_recharged : 0) + Number(tx.amount);

          await supabase.from('wallets').upsert({
            user_id: tx.user_id,
            balance: newBal,
            total_recharged: newRecharged,
            updated_at: new Date().toISOString(),
          });
        }
      }

      return res.json({ ok: true, status: 'PAID', message: 'Payment successfully verified!' });
    }

    res.json({ ok: false, status: orderData.order_status, message: 'Payment is not completed yet.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Cashfree Server-to-Server Webhook Handler
 * Instant balance credit & subscription activation even if user closes the tab!
 */
app.post('/api/pay/webhook', async (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-webhook-timestamp'];
  const rawBody = req.rawBody || JSON.stringify(req.body);

  if (signature && timestamp) {
    const isValid = cashfree.verifyWebhookSignature(rawBody, signature, timestamp);
    if (!isValid) {
      console.warn('⚠️ Rejected Cashfree webhook with invalid signature.');
      return res.status(401).json({ ok: false, message: 'Invalid webhook signature' });
    }
  }

  try {
    const supabase = getSupabase();
    const eventType = req.body && req.body.type;
    const orderData = req.body && req.body.data && req.body.data.order;
    const paymentData = req.body && req.body.data && req.body.data.payment;

    if (eventType === 'PAYMENT_SUCCESS_WEBHOOK' || (paymentData && paymentData.payment_status === 'SUCCESS')) {
      const orderId = orderData && orderData.order_id;
      if (orderId) {
        const { data: tx } = await supabase
          .from('transactions')
          .select('*')
          .eq('cashfree_order_id', orderId)
          .maybeSingle();

        if (tx && tx.status !== 'SUCCESS') {
          await supabase.from('transactions').update({
            status: 'SUCCESS',
            details: req.body,
          }).eq('id', tx.id);

          if (tx.type === 'SUBSCRIPTION_699') {
            const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
            await supabase.from('subscriptions').insert([{
              user_id: tx.user_id,
              plan_name: 'MONTHLY_699',
              expires_at: expiresAt,
              is_active: true,
            }]);
          } else if (tx.type === 'WALLET_RECHARGE') {
            const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', tx.user_id).maybeSingle();
            const newBal = Number(wallet ? wallet.balance : 0) + Number(tx.amount);
            const newRecharged = Number(wallet ? wallet.total_recharged : 0) + Number(tx.amount);

            await supabase.from('wallets').upsert({
              user_id: tx.user_id,
              balance: newBal,
              total_recharged: newRecharged,
              updated_at: new Date().toISOString(),
            });
          }
          console.log(`✅ Webhook verified & processed for order: ${orderId}`);
        }
      }
    }

    res.status(200).json({ status: 'OK' });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ ok: false, message: err.message });
  }
});

// -------------------------------------------------------------------------
// 3. SECURE IN-MEMORY AUTOMATION SCRIPT DELIVERY
// -------------------------------------------------------------------------

/**
 * Returns encrypted automation script into RAM only after verifying active subscription or wallet
 */
app.post('/api/script/fetch-payload', async (req, res) => {
  const { userId, hwid } = req.body;
  if (!userId || !hwid) {
    return res.status(400).json({ ok: false, message: 'Authentication details missing' });
  }

  try {
    const supabase = getSupabase();

    // Verify User and HWID
    const { data: user, error: userErr } = await supabase.from('users').select('*').eq('id', userId).single();
    if (userErr || !user) throw new Error('User not found');
    if (user.is_blocked) throw new Error('User is blocked');
    if (user.hwid !== hwid) throw new Error('HWID device mismatch');

    // Check plan or wallet balance
    const { data: subs } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', user.id).maybeSingle();
    const balance = Number(wallet ? wallet.balance : 0);

    if (!subs && balance < 1.00) {
      return res.status(402).json({
        ok: false,
        code: 'PAYMENT_REQUIRED',
        message: 'Kripya recharge karein! Na toh koi active ₹699 subscription hai aur wallet balance bhi ₹1 se kam hai.',
      });
    }

    // Fetch latest remote encrypted script
    const { data: scriptRow, error: scriptErr } = await supabase
      .from('remote_scripts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (scriptErr || !scriptRow) {
      return res.status(404).json({
        ok: false,
        message: 'No active automation script found on cloud server. Please publish via Admin Panel.',
      });
    }

    res.json({
      ok: true,
      version: scriptRow.version,
      encrypted_code: scriptRow.encrypted_code,
      iv: scriptRow.iv,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Deducts ₹1 per kila or increments total kilas for subscription users
 */
app.post('/api/kila/deduct', async (req, res) => {
  const { userId, hwid, kilaNumber } = req.body;
  if (!userId || !hwid) return res.status(400).json({ ok: false, message: 'Invalid payload' });

  try {
    const supabase = getSupabase();
    const { data: user } = await supabase.from('users').select('*').eq('id', userId).single();
    if (!user || user.hwid !== hwid || user.is_blocked) throw new Error('Unauthorized');

    // Check active subscription
    const { data: subs } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', user.id).single();

    const secret = process.env.SCRIPT_ENCRYPTION_SECRET || 'onfarm_super_secure_secret_key32';
    const authNonce = crypto
      .createHmac('sha256', secret)
      .update(`${user.id}:${hwid}:${kilaNumber || ''}:${Date.now()}`)
      .digest('hex');

    if (subs) {
      // Unlimited subscription — just increment kilas count
      await supabase.from('wallets').update({
        total_kilas_processed: (wallet.total_kilas_processed || 0) + 1,
      }).eq('user_id', user.id);

      return res.json({ ok: true, plan: 'SUBSCRIPTION_UNLIMITED', remaining_balance: wallet.balance, authNonce });
    }

    // Wallet user — deduct ₹1
    const currentBalance = Number(wallet.balance || 0);
    if (currentBalance < 1.00) {
      return res.status(402).json({
        ok: false,
        code: 'INSUFFICIENT_FUNDS',
        message: 'Wallet balance khatam ho gaya hai! Kripya agla kila bharne se pehle recharge karein.',
      });
    }

    const updatedBalance = currentBalance - 1.00;
    await supabase.from('wallets').update({
      balance: updatedBalance,
      total_kilas_processed: (wallet.total_kilas_processed || 0) + 1,
      updated_at: new Date().toISOString(),
    }).eq('user_id', user.id);

    // Record debit transaction
    await supabase.from('transactions').insert([{
      user_id: user.id,
      amount: 1.00,
      type: 'KILA_DEBIT',
      status: 'SUCCESS',
      details: { kila: kilaNumber || 'Unknown' },
    }]);

    res.json({
      ok: true,
      plan: 'WALLET_PAY_PER_KILA',
      deducted: 1.00,
      remaining_balance: updatedBalance,
      authNonce,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// -------------------------------------------------------------------------
// 4. SUPER ADMIN ENDPOINTS (Protected by x-admin-key)
// -------------------------------------------------------------------------

function requireAdmin(req, res, next) {
  const key = String(req.headers['x-admin-key'] || '').trim();
  const expectedKey = String(process.env.ADMIN_SECRET_KEY || 'onfarm_admin_master_2026').trim();
  if (!key || key.length !== expectedKey.length) {
    return res.status(401).json({ ok: false, message: 'Invalid Admin Key' });
  }
  const keyBuf = Buffer.from(key);
  const expBuf = Buffer.from(expectedKey);
  if (!crypto.timingSafeEqual(keyBuf, expBuf)) {
    return res.status(401).json({ ok: false, message: 'Invalid Admin Key' });
  }
  next();
}

/**
 * Admin Stats Overview
 */
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { count: totalUsers } = await supabase.from('users').select('*', { count: 'exact', head: true });
    const { count: activeSubs } = await supabase.from('subscriptions').select('*', { count: 'exact', head: true }).gt('expires_at', new Date().toISOString());
    const { data: wallets } = await supabase.from('wallets').select('balance, total_kilas_processed');

    const totalWalletMoney = (wallets || []).reduce((acc, w) => acc + Number(w.balance || 0), 0);
    const totalKilasProcessed = (wallets || []).reduce((acc, w) => acc + (w.total_kilas_processed || 0), 0);

    res.json({
      ok: true,
      stats: {
        total_users: totalUsers || 0,
        active_subscriptions: activeSubs || 0,
        total_wallet_money: totalWalletMoney,
        total_kilas_processed: totalKilasProcessed,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Admin Users List
 */
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data: users, error } = await supabase
      .from('users')
      .select('*, wallets(*), subscriptions(*)')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ ok: true, users });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Admin: Toggle Block / Unblock User
 */
app.post('/api/admin/user/toggle-block', requireAdmin, async (req, res) => {
  const { userId, isBlocked } = req.body;
  try {
    const supabase = getSupabase();
    await supabase.from('users').update({ is_blocked: isBlocked }).eq('id', userId);
    res.json({ ok: true, message: `User status updated: ${isBlocked ? 'BLOCKED' : 'ACTIVE'}` });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Admin: Reset User HWID (Allows device switch)
 */
app.post('/api/admin/user/reset-hwid', requireAdmin, async (req, res) => {
  const { userId } = req.body;
  try {
    const supabase = getSupabase();
    await supabase.from('users').update({ hwid: null }).eq('id', userId);
    res.json({ ok: true, message: 'HWID reset successfully. User can now bind a new PC.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Admin: Permanently Delete User
 */
app.post('/api/admin/user/delete', requireAdmin, async (req, res) => {
  const { userId } = req.body;
  try {
    const supabase = getSupabase();
    await supabase.from('wallets').delete().eq('user_id', userId);
    await supabase.from('subscriptions').delete().eq('user_id', userId);
    await supabase.from('transactions').delete().eq('user_id', userId);
    await supabase.from('users').delete().eq('id', userId);
    res.json({ ok: true, message: 'User deleted successfully.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Admin: Adjust Wallet Balance (Credit or Debit)
 */
app.post('/api/admin/user/adjust-wallet', requireAdmin, async (req, res) => {
  const { userId, amountDelta } = req.body; // e.g. +100 or -50
  if (!userId || amountDelta === undefined || isNaN(Number(amountDelta))) {
    return res.status(400).json({ ok: false, message: 'userId and numeric amountDelta are required' });
  }
  try {
    const supabase = getSupabase();
    const { data: wallet, error: wErr } = await supabase.from('wallets').select('*').eq('user_id', userId).maybeSingle();
    if (wErr) throw wErr;

    const current = Number(wallet ? wallet.balance : 0);
    const updated = Math.max(0, current + Number(amountDelta));

    if (!wallet) {
      await supabase.from('wallets').insert([{
        user_id: userId,
        balance: updated,
        total_recharged: Math.max(0, Number(amountDelta)),
        total_kilas_processed: 0,
      }]);
    } else {
      await supabase.from('wallets').update({
        balance: updated,
        total_recharged: Number(amountDelta) > 0 ? (Number(wallet.total_recharged || 0) + Number(amountDelta)) : wallet.total_recharged,
        updated_at: new Date().toISOString(),
      }).eq('user_id', userId);
    }

    res.json({ ok: true, message: `Wallet updated: ₹${updated}`, balance: updated });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Admin: Grant/Extend 30-Day Subscription
 */
app.post('/api/admin/user/grant-subscription', requireAdmin, async (req, res) => {
  const { userId, days = 30 } = req.body;
  try {
    const supabase = getSupabase();
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('subscriptions').insert([{
      user_id: userId,
      plan_name: 'MONTHLY_699',
      expires_at: expiresAt,
      is_active: true,
    }]);

    res.json({ ok: true, message: `Granted ${days} days unlimited subscription.`, expires_at: expiresAt });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Admin: 1-Click Remote Update Push
 * Encrypts given plain JavaScript automation code and updates minimum version
 */
app.post('/api/admin/publish-script', requireAdmin, async (req, res) => {
  const { version, plainCode, description, minSupportedVersion } = req.body;
  if (!version || !plainCode) {
    return res.status(400).json({ ok: false, message: 'version and plainCode are required' });
  }

  try {
    const supabase = getSupabase();
    const { encrypted_code, iv } = encryptScript(plainCode);

    await supabase.from('remote_scripts').upsert({
      version,
      encrypted_code,
      iv,
      description: description || 'Cloud pushed update',
    });

    if (minSupportedVersion) {
      await supabase.from('app_config').upsert({
        key: 'version_gate',
        value: {
          latest_version: version,
          min_supported_version: minSupportedVersion,
          force_update: true,
        },
        updated_at: new Date().toISOString(),
      });
    }

    res.json({
      ok: true,
      message: `Successfully published version ${version} to cloud server! All client machines will receive this update instantly in RAM.`,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Start Server if run directly
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`  ON-FARM SAAS CLOUD BACKEND RUNNING ON PORT ${PORT}`);
    console.log(`  Health Check: http://localhost:${PORT}/api/health`);
    console.log(`======================================================\n`);
  });
}

module.exports = app;

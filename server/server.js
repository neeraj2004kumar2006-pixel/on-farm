// server/server.js
// On-Farm Production Backend Service (Serverless on Vercel)
// Hardened with two-phase reservation ledger, atomic RPCs, strict webhook verification, and sanitized public config

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const cashfree = require('./cashfree');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4000;

// Security Headers Middleware (Zero external dependencies)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});
app.use(cors());

// Capture raw body for Cashfree webhook signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
  limit: '2mb',
}));

// Serve static Super Admin Console
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// Singleton Supabase Client (Reuses keep-alive connections on warm serverless instances)
let supabaseClient = null;
function getSupabase() {
  if (!supabaseClient) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('Supabase credentials missing in server environment variables.');
    }
    supabaseClient = createClient(url, key, {
      auth: { persistSession: false },
    });
  }
  return supabaseClient;
}

// -------------------------------------------------------------------------
// 1. PUBLIC HEALTH & CONFIGURATION ENDPOINTS
// -------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    status: 'ONLINE',
    timestamp: new Date().toISOString(),
    service: 'On-Farm Cloud License Server',
  });
});

/**
 * Version Gate & Remote Config (Safe Public Config ONLY)
 * Strips out sensitive keys like ref_link_* to prevent user UUID/phone leaks
 */
app.get('/api/config', async (req, res) => {
  try {
    const supabase = getSupabase();
    const ALLOWED_CONFIG_KEYS = ['version_gate', 'pricing_plans', 'announcements'];
    const { data, error } = await supabase
      .from('app_config')
      .select('key, value')
      .in('key', ALLOWED_CONFIG_KEYS);

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
 * Device Status (HWID Single Source of Truth)
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
      .select('id, name, phone, hwid, is_blocked')
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
      .limit(1)
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
  const { phone, name, hwid, email, referralCode } = req.body;
  if (!phone || !hwid) {
    return res.status(400).json({ ok: false, message: 'Phone number and HWID are required' });
  }

  const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
  if (cleanPhone.length !== 10) {
    return res.status(400).json({ ok: false, message: 'Please enter a valid 10-digit mobile number' });
  }

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
      .select('*')
      .eq('phone', cleanPhone)
      .maybeSingle();

    if (error) throw error;

    if (!user) {
      // Auto-register new user — permanently binds HWID to this device!
      const { data: newUser, error: createErr } = await supabase
        .from('users')
        .insert([{
          phone: cleanPhone,
          name: name || `Operator ${cleanPhone.slice(-4)}`,
          email: email || '',
          hwid,
          is_blocked: false,
        }])
        .select('*')
        .single();

      if (createErr) throw createErr;
      user = newUser;

      // Handle referral code linking if provided
      if (referralCode) {
        const cleanRef = String(referralCode).replace(/\D/g, '').slice(-10);
        if (cleanRef.length === 10 && cleanRef !== cleanPhone) {
          const { data: referrer } = await supabase.from('users').select('id, phone').eq('phone', cleanRef).maybeSingle();
          if (referrer && referrer.id !== user.id) {
            // Save in referrals table
            await supabase.from('referrals').insert([{
              referred_user_id: user.id,
              referrer_user_id: referrer.id,
              bonus: 25.00,
            }]).catch(() => {});
          }
        }
      }
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
      .limit(1)
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
      message: hasActiveSubscription
        ? 'Login successful. Active 30-Day Monthly Pass verified.'
        : `Login successful. Available Wallet Balance: ₹${walletBalance}`,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// -------------------------------------------------------------------------
// 2. CASHFREE PAYMENTS (₹1/KILA WALLET & ₹699/MONTH SUBSCRIPTION)
// -------------------------------------------------------------------------

/**
 * Creates a Cashfree payment order with strict amount bounds
 */
app.post('/api/pay/create-order', async (req, res) => {
  const { userId, type, customAmount, returnUrl } = req.body;
  if (!userId || !type) {
    return res.status(400).json({ ok: false, message: 'userId and type are required' });
  }

  let amount = 699.00;
  let orderNote = 'On-Farm 30-Day Unlimited Subscription Pass';

  if (type === 'WALLET_RECHARGE') {
    // Strictly cap recharge bounds: Min ₹1, Max ₹10,000
    const rawAmt = Number(customAmount || 10.00);
    amount = Math.min(10000.00, Math.max(1.00, Math.round(rawAmt * 100) / 100));
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
 * Verifies payment order status with Cashfree atomically
 */
app.post('/api/pay/verify', async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) {
    return res.status(400).json({ ok: false, message: 'orderId is required' });
  }

  try {
    const supabase = getSupabase();
    const orderData = await cashfree.getOrderStatus(orderId);

    if (orderData.order_status === 'PAID') {
      // Atomic apply via Postgres function
      const { data: applyRes, error: applyErr } = await supabase.rpc('apply_cashfree_payment', {
        p_order_id: orderId,
        p_payload: orderData,
      });

      if (!applyErr && applyRes && applyRes.ok) {
        return res.json({ ok: true, status: 'PAID', message: 'Payment successfully verified!' });
      }

      // Safe fallback if RPC not yet migrated
      const { data: tx } = await supabase
        .from('transactions')
        .select('*')
        .eq('cashfree_order_id', orderId)
        .maybeSingle();

      if (tx && tx.status !== 'SUCCESS') {
        await supabase.from('transactions').update({ status: 'SUCCESS' }).eq('id', tx.id);
        if (tx.type === 'SUBSCRIPTION_699') {
          const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          await supabase.from('subscriptions').insert([{
            user_id: tx.user_id,
            plan_name: 'MONTHLY_699',
            expires_at: expiresAt,
            is_active: true,
          }]);
          await grantReferralBonusIfEligible(tx.user_id, supabase);
        } else if (tx.type === 'WALLET_RECHARGE') {
          const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', tx.user_id).maybeSingle();
          const newBal = Number(wallet ? wallet.balance : 0) + Number(tx.amount);
          await supabase.from('wallets').upsert({
            user_id: tx.user_id,
            balance: newBal,
            total_recharged: Number(wallet ? wallet.total_recharged : 0) + Number(tx.amount),
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
 * Strictly enforces signature verification (Returns 401 if missing or invalid)
 */
app.post('/api/pay/webhook', async (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-webhook-timestamp'];
  const rawBody = req.rawBody || JSON.stringify(req.body);

  // Mandatory signature check: fail closed!
  if (!signature || !timestamp) {
    console.warn('⚠️ Rejected Cashfree webhook: missing signature headers.');
    return res.status(401).json({ ok: false, message: 'Missing webhook signature headers' });
  }

  const isValid = cashfree.verifyWebhookSignature(rawBody, signature, timestamp);
  if (!isValid) {
    console.warn('⚠️ Rejected Cashfree webhook: invalid signature.');
    return res.status(401).json({ ok: false, message: 'Invalid webhook signature' });
  }

  try {
    const supabase = getSupabase();
    const eventType = req.body && req.body.type;
    const orderData = req.body && req.body.data && req.body.data.order;
    const paymentData = req.body && req.body.data && req.body.data.payment;

    if (eventType === 'PAYMENT_SUCCESS_WEBHOOK' || (paymentData && paymentData.payment_status === 'SUCCESS')) {
      const orderId = orderData && orderData.order_id;
      if (orderId) {
        // Atomic apply via Postgres function
        await supabase.rpc('apply_cashfree_payment', {
          p_order_id: orderId,
          p_payload: req.body,
        });
      }
    }

    res.status(200).json({ status: 'OK' });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ ok: false, message: err.message });
  }
});

// -------------------------------------------------------------------------
// 3. SECURE AUTOMATION SCRIPT DELIVERY & KILA TWO-PHASE LEDGER
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
    const { data: user, error: userErr } = await supabase.from('users').select('*').eq('id', userId).single();
    if (userErr || !user) throw new Error('User not found');

    if (user.is_blocked) throw new Error('User is blocked');
    if (user.hwid && user.hwid !== hwid) {
      throw new Error('HWID device mismatch. Account bound to another installation.');
    }

    const { data: subs } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .gt('expires_at', new Date().toISOString())
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', user.id).maybeSingle();
    const hasBalance = Number(wallet ? wallet.balance : 0) >= 1.00;

    if (!subs && !hasBalance) {
      return res.status(402).json({
        ok: false,
        code: 'PAYMENT_REQUIRED',
        message: 'Aapka wallet balance khatam ho gaya hai. Kripya ₹1/kila recharge karein ya Monthly Pass lein.',
      });
    }

    const { data: scriptData, error: scriptErr } = await supabase
      .from('remote_scripts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (scriptErr || !scriptData) {
      throw new Error('Automation script not configured on cloud server.');
    }

    res.json({
      ok: true,
      version: scriptData.version,
      encrypted_code: scriptData.encrypted_code,
      iv: scriptData.iv,
      plan: subs ? 'SUBSCRIPTION_UNLIMITED' : 'WALLET_PAY_PER_KILA',
      walletBalance: Number(wallet ? wallet.balance : 0),
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Phase 1: Authorize & Deduct Kila (Atomic via Postgres RPC)
 */
app.post('/api/kila/deduct', async (req, res) => {
  const { userId, hwid, kilaNumber, chargeKey } = req.body;
  if (!userId || !hwid) return res.status(400).json({ ok: false, message: 'Invalid payload' });

  const effectiveKey = chargeKey || `${userId}_${kilaNumber || '0'}_${Date.now()}`;

  try {
    const supabase = getSupabase();
    const { data: user } = await supabase.from('users').select('*').eq('id', userId).single();
    if (!user || user.hwid !== hwid || user.is_blocked) throw new Error('Unauthorized');

    const secret = process.env.SCRIPT_ENCRYPTION_SECRET || 'onfarm_super_secure_secret_key32';
    const authNonce = crypto
      .createHmac('sha256', secret)
      .update(`${user.id}:${hwid}:${effectiveKey}:${Date.now()}`)
      .digest('hex');

    // Call atomic Postgres RPC
    const { data: rpcRes, error: rpcErr } = await supabase.rpc('authorize_kila', {
      p_user: user.id,
      p_key: effectiveKey,
      p_amount: 1.00,
    });

    if (!rpcErr && rpcRes) {
      if (!rpcRes.ok) {
        return res.status(rpcRes.code === 'INSUFFICIENT_FUNDS' ? 402 : 400).json(rpcRes);
      }
      return res.json({
        ok: true,
        plan: rpcRes.plan || 'WALLET_PAY_PER_KILA',
        deducted: rpcRes.deducted !== undefined ? rpcRes.deducted : 1.00,
        remaining_balance: rpcRes.remaining_balance,
        authNonce,
        chargeKey: effectiveKey,
      });
    }

    // Safe fallback if RPC not yet migrated
    const { data: subs } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .gt('expires_at', new Date().toISOString())
      .limit(1)
      .maybeSingle();

    const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', user.id).single();

    if (subs) {
      await supabase.from('wallets').update({
        total_kilas_processed: (wallet.total_kilas_processed || 0) + 1,
      }).eq('user_id', user.id);
      return res.json({ ok: true, plan: 'SUBSCRIPTION_UNLIMITED', remaining_balance: wallet.balance, authNonce, chargeKey: effectiveKey });
    }

    const currentBalance = Number(wallet.balance || 0);
    if (currentBalance < 1.00) {
      return res.status(402).json({ ok: false, code: 'INSUFFICIENT_FUNDS', message: 'Wallet balance khatam ho gaya hai.' });
    }

    const updatedBalance = currentBalance - 1.00;
    await supabase.from('wallets').update({
      balance: updatedBalance,
      total_kilas_processed: (wallet.total_kilas_processed || 0) + 1,
      updated_at: new Date().toISOString(),
    }).eq('user_id', user.id);

    res.json({
      ok: true,
      plan: 'WALLET_PAY_PER_KILA',
      deducted: 1.00,
      remaining_balance: updatedBalance,
      authNonce,
      chargeKey: effectiveKey,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Phase 2: Commit Kila (Marks charge COMMITTED after form successfully submitted)
 */
app.post('/api/kila/commit', async (req, res) => {
  const { userId, hwid, chargeKey } = req.body;
  if (!userId || !hwid || !chargeKey) return res.status(400).json({ ok: false, message: 'Invalid payload' });

  try {
    const supabase = getSupabase();
    await supabase.rpc('commit_kila', {
      p_user: userId,
      p_key: chargeKey,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Phase 3: Rollback / Refund Kila (ONLY valid from 'RESERVED' state within 10 minutes)
 * Completely eliminates arbitrary refund abuse / money minting!
 */
app.post('/api/kila/refund', async (req, res) => {
  const { userId, hwid, chargeKey, reason } = req.body;
  if (!userId || !hwid || !chargeKey) {
    return res.status(400).json({ ok: false, message: 'Invalid payload: userId, hwid and chargeKey are required' });
  }

  try {
    const supabase = getSupabase();
    const { data: user } = await supabase.from('users').select('*').eq('id', userId).single();
    if (!user || user.hwid !== hwid || user.is_blocked) throw new Error('Unauthorized');

    // Call atomic Postgres refund function
    const { data: refRes, error: refErr } = await supabase.rpc('refund_kila', {
      p_user: user.id,
      p_key: chargeKey,
      p_reason: reason || 'Portal error rollback',
    });

    if (!refErr && refRes) {
      if (!refRes.ok) {
        return res.status(400).json(refRes);
      }
      return res.json(refRes);
    }

    return res.status(400).json({ ok: false, code: 'NOT_REFUNDABLE', message: 'Kila charge is not eligible for refund.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Fetch User Transaction & Deduction History
 */
app.get('/api/user/transactions', async (req, res) => {
  try {
    const { userId, hwid } = req.query;
    if (!userId) return res.status(400).json({ ok: false, message: 'userId is required' });
    const supabase = getSupabase();

    const { data: user } = await supabase.from('users').select('id, hwid').eq('id', userId).single();
    if (!user || (hwid && user.hwid && user.hwid !== hwid)) {
      return res.status(403).json({ ok: false, message: 'Invalid device credentials' });
    }

    const { data: txs, error } = await supabase
      .from('transactions')
      .select('id, amount, type, status, details, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ ok: true, transactions: txs || [] });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Referral Stats
 */
app.get('/api/user/referral-stats', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ ok: false, message: 'userId is required' });
    const supabase = getSupabase();

    const { data: user } = await supabase.from('users').select('id, phone').eq('id', userId).single();
    if (!user) {
      return res.status(404).json({ ok: false, message: 'User not found' });
    }

    // Query referrals table directly
    const { data: myRefs } = await supabase
      .from('referrals')
      .select('referred_user_id, bonus, linked_at, rewarded_at, users!referrals_referred_user_id_fkey(phone)')
      .eq('referrer_user_id', user.id);

    const refList = myRefs || [];
    const successfulCount = refList.filter(r => r.rewarded_at).length;
    const totalEarned = successfulCount * 25.00;

    const referredUsers = refList.map(r => ({
      phone: r.users ? r.users.phone : 'Protected',
      linked_at: r.linked_at,
      rewarded: !!r.rewarded_at,
      rewarded_at: r.rewarded_at,
      status: r.rewarded_at ? 'Monthly Pass Active (+₹25)' : 'Registered (Pass Pending)',
    }));

    res.json({
      ok: true,
      referralCode: user.phone,
      totalEarned,
      successfulCount,
      totalReferred: refList.length,
      referredUsers,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Check Referral Status
 */
app.get('/api/user/referral-status', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ ok: false, message: 'userId is required' });
    const supabase = getSupabase();

    const { data: ref } = await supabase
      .from('referrals')
      .select('referrer_user_id, users!referrals_referrer_user_id_fkey(phone)')
      .eq('referred_user_id', userId)
      .maybeSingle();

    if (ref && ref.users) {
      return res.json({
        ok: true,
        linked: true,
        referrerPhone: ref.users.phone,
      });
    }

    return res.json({ ok: true, linked: false });
  } catch (err) {
    return res.json({ ok: true, linked: false });
  }
});

/**
 * Link Referral Code
 */
app.post('/api/user/link-referral', async (req, res) => {
  try {
    const { userId, referralCode } = req.body;
    if (!userId || !referralCode) {
      return res.status(400).json({ ok: false, message: 'userId and referralCode are required' });
    }
    const supabase = getSupabase();
    const { data: user } = await supabase.from('users').select('id, phone').eq('id', userId).single();
    if (!user) {
      return res.status(404).json({ ok: false, message: 'User not found' });
    }

    const { data: existingRef } = await supabase
      .from('referrals')
      .select('referrer_user_id')
      .eq('referred_user_id', user.id)
      .maybeSingle();

    if (existingRef) {
      return res.status(400).json({
        ok: false,
        message: 'A referral code has already been linked to your account.',
      });
    }

    const cleanRef = String(referralCode).replace(/\D/g, '').slice(-10);
    if (!cleanRef || cleanRef.length !== 10) {
      return res.status(400).json({ ok: false, message: 'Please enter a valid 10-digit referral mobile number.' });
    }
    if (cleanRef === user.phone) {
      return res.status(400).json({ ok: false, message: 'You cannot refer your own mobile number.' });
    }

    const { data: referrer } = await supabase.from('users').select('id, phone').eq('phone', cleanRef).maybeSingle();
    if (!referrer) {
      return res.status(404).json({ ok: false, message: 'No registered operator found with this referral number.' });
    }
    if (referrer.id === user.id) {
      return res.status(400).json({ ok: false, message: 'You cannot use your own referral code.' });
    }

    await supabase.from('referrals').insert([{
      referred_user_id: user.id,
      referrer_user_id: referrer.id,
      bonus: 25.00,
    }]);

    // If user already has active pass, grant bonus now
    await grantReferralBonusIfEligible(user.id, supabase);

    res.json({ ok: true, message: `Successfully linked referral to +91 ${referrer.phone}!` });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

async function grantReferralBonusIfEligible(userId, supabase) {
  try {
    const { data: granted } = await supabase.rpc('grant_referral_bonus', {
      p_referred: userId,
    });
    return !!granted;
  } catch (err) {
    return false;
  }
}

// -------------------------------------------------------------------------
// 4. SUPER ADMIN ENDPOINTS (Protected by x-admin-key)
// -------------------------------------------------------------------------

function requireAdmin(req, res, next) {
  const key = String(req.headers['x-admin-key'] || '').trim();
  if (!key) {
    return res.status(401).json({ ok: false, message: 'Invalid Admin Key' });
  }

  const PRIMARY_KEY = String(process.env.ADMIN_SECRET_KEY || 'Npneeraj@2754').trim();

  try {
    const keyBuf = Buffer.alloc(PRIMARY_KEY.length);
    const expBuf = Buffer.from(PRIMARY_KEY);
    Buffer.from(key.padEnd(PRIMARY_KEY.length).slice(0, PRIMARY_KEY.length)).copy(keyBuf);
    if (key.length === PRIMARY_KEY.length && crypto.timingSafeEqual(keyBuf, expBuf)) {
      return next();
    }
  } catch {}

  return res.status(401).json({ ok: false, message: 'Unauthorized: Invalid Admin Password' });
}

/**
 * Admin Stats Overview (Calls Postgres RPC to completely avoid 1,000-row Supabase limit)
 */
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const supabase = getSupabase();
    
    // Call atomic summary RPC
    const { data: summary, error: sumErr } = await supabase.rpc('admin_financial_summary');
    if (!sumErr && summary) {
      return res.json({ ok: true, stats: summary });
    }

    // Fallback if RPC not yet migrated
    const { count: totalUsers } = await supabase.from('users').select('*', { count: 'exact', head: true });
    const { count: activeSubs } = await supabase.from('subscriptions').select('*', { count: 'exact', head: true }).gt('expires_at', new Date().toISOString());
    const { data: wallets } = await supabase.from('wallets').select('balance, total_recharged, total_kilas_processed');

    const totalWalletMoney = (wallets || []).reduce((acc, w) => acc + Number(w.balance || 0), 0);
    const totalKilasProcessed = (wallets || []).reduce((acc, w) => acc + (w.total_kilas_processed || 0), 0);
    const totalAllRecharged = (wallets || []).reduce((acc, w) => acc + Number(w.total_recharged || 0), 0);

    res.json({
      ok: true,
      stats: {
        total_users: totalUsers || 0,
        active_subscriptions: activeSubs || 0,
        total_wallet_money: totalWalletMoney,
        total_recharge_money: totalAllRecharged,
        total_referral_money: 0,
        total_combined_funds: totalAllRecharged,
        total_referral_passes: 0,
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
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) throw error;

    const formatted = (users || []).map(u => {
      const activeSub = (u.subscriptions || []).find(s => s.is_active && new Date(s.expires_at) > new Date());
      const wallet = Array.isArray(u.wallets) ? u.wallets[0] : u.wallets;
      return {
        id: u.id,
        phone: u.phone,
        name: u.name,
        hwid: u.hwid,
        is_blocked: u.is_blocked,
        created_at: u.created_at,
        last_active_at: u.last_active_at,
        wallet: wallet ? {
          balance: Number(wallet.balance || 0),
          total_recharged: Number(wallet.total_recharged || 0),
          total_kilas_processed: wallet.total_kilas_processed || 0,
        } : { balance: 0, total_recharged: 0, total_kilas_processed: 0 },
        subscription: activeSub ? {
          plan_name: activeSub.plan_name,
          expires_at: activeSub.expires_at,
          is_active: true,
        } : null,
      };
    });

    res.json({ ok: true, users: formatted });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Block / Unblock User (Supports both /toggle-block and /block route paths)
 */
const handleBlockUser = async (req, res) => {
  const { userId, isBlocked } = req.body;
  try {
    const supabase = getSupabase();
    await supabase.from('users').update({ is_blocked: isBlocked }).eq('id', userId);
    res.json({ ok: true, message: `User status updated: ${isBlocked ? 'BLOCKED' : 'ACTIVE'}` });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
};
app.post('/api/admin/user/toggle-block', requireAdmin, handleBlockUser);
app.post('/api/admin/user/block', requireAdmin, handleBlockUser);

/**
 * Admin: Reset HWID
 */
app.post('/api/admin/user/reset-hwid', requireAdmin, async (req, res) => {
  const { userId } = req.body;
  try {
    const supabase = getSupabase();
    await supabase.from('users').update({ hwid: null }).eq('id', userId);
    res.json({ ok: true, message: 'HWID reset successful. User can bind a new computer.' });
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
    await supabase.from('referrals').delete().or(`referred_user_id.eq.${userId},referrer_user_id.eq.${userId}`);
    await supabase.from('wallets').delete().eq('user_id', userId);
    await supabase.from('subscriptions').delete().eq('user_id', userId);
    await supabase.from('transactions').delete().eq('user_id', userId);
    await supabase.from('users').delete().eq('id', userId);

    res.json({ ok: true, message: 'User and all associated records permanently deleted.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Admin: Adjust Wallet
 */
app.post('/api/admin/user/adjust-wallet', requireAdmin, async (req, res) => {
  const { userId, amount, reason } = req.body;
  try {
    const supabase = getSupabase();
    const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', userId).maybeSingle();
    const updated = Math.max(0, Number(wallet ? wallet.balance : 0) + Number(amount));

    await supabase.from('wallets').upsert({
      user_id: userId,
      balance: updated,
      updated_at: new Date().toISOString(),
    });

    await supabase.from('transactions').insert([{
      user_id: userId,
      amount: Math.abs(amount),
      type: amount >= 0 ? 'WALLET_RECHARGE' : 'KILA_DEBIT',
      status: 'SUCCESS',
      details: { admin_adjustment: true, reason: reason || 'Manual Admin Credit' },
    }]);

    res.json({ ok: true, balance: updated });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Admin: Grant 30-Day Pass
 */
app.post('/api/admin/user/grant-subscription', requireAdmin, async (req, res) => {
  const { userId, days = 30, referrerPhone } = req.body;
  try {
    const supabase = getSupabase();
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('subscriptions').insert([{
      user_id: userId,
      plan_name: 'MONTHLY_699',
      expires_at: expiresAt,
      is_active: true,
    }]);

    if (referrerPhone) {
      const cleanRef = String(referrerPhone).replace(/\D/g, '').slice(-10);
      if (cleanRef.length === 10) {
        const { data: referrer } = await supabase.from('users').select('id, phone').eq('phone', cleanRef).maybeSingle();
        if (referrer && referrer.id !== userId) {
          await supabase.from('referrals').insert([{
            referred_user_id: userId,
            referrer_user_id: referrer.id,
            bonus: 25.00,
          }]).catch(() => {});
        }
      }
    }

    await grantReferralBonusIfEligible(userId, supabase);

    res.json({ ok: true, message: `Granted ${days} days unlimited subscription.`, expires_at: expiresAt });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Admin: Publish Encrypted Automation Script
 */
app.post('/api/admin/publish-script', requireAdmin, async (req, res) => {
  const { version, plainCode, description } = req.body;
  if (!version || !plainCode) {
    return res.status(400).json({ ok: false, message: 'version and plainCode are required' });
  }

  try {
    const secret = process.env.SCRIPT_ENCRYPTION_SECRET || 'onfarm_super_secure_secret_key32';
    const key = crypto.createHash('sha256').update(secret).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(plainCode, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const supabase = getSupabase();
    await supabase.from('remote_scripts').upsert({
      version,
      encrypted_code: encrypted,
      iv: iv.toString('hex'),
      description: description || 'Routine production update',
      created_at: new Date().toISOString(),
    });

    res.json({ ok: true, message: `Script v${version} published successfully.` });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Start Server when run directly
if (process.env.NODE_ENV !== 'production' && require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;

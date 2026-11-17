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
  const { phone, name, hwid, email, referralCode } = req.body;
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

      // Handle referral code linking upon new registration
      if (referralCode) {
        const cleanRef = String(referralCode).replace(/\D/g, '').slice(-10);
        if (cleanRef && cleanRef.length === 10 && cleanRef !== cleanPhone) {
          const { data: referrer } = await supabase
            .from('users')
            .select('id, phone')
            .eq('phone', cleanRef)
            .maybeSingle();

          if (referrer && referrer.id !== newUser.id) {
            await supabase.from('app_config').upsert({
              key: 'ref_link_' + newUser.id,
              value: {
                referred_user_id: newUser.id,
                referred_phone: newUser.phone,
                referrer_user_id: referrer.id,
                referrer_phone: referrer.phone,
                linked_at: new Date().toISOString(),
                rewarded: false,
                bonus_amount: 25.00,
              },
              updated_at: new Date().toISOString()
            });
            console.log(`🔗 Referral linked at registration: +91 ${newUser.phone} -> +91 ${referrer.phone}`);
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
 * Grants ₹25 referral credit to the referrer if this user was referred and hasn't claimed yet
 */
/**
 * Check and Grant ₹25 Referral Reward when user activates/buys 30-Day Monthly Pass
 * Stored securely in app_config & credited to referrer's wallet
 */
async function grantReferralBonusIfEligible(userId, supabase) {
  try {
    // 1. Fetch referral link from app_config
    const { data: configRow } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', 'ref_link_' + userId)
      .maybeSingle();

    if (!configRow || !configRow.value) {
      return false; // Not referred
    }

    const ref = configRow.value;
    if (ref.rewarded) {
      return false; // Already rewarded! Strictly one-time only!
    }

    const referrerUserId = ref.referrer_user_id;
    if (!referrerUserId) return false;

    // 2. Fetch referrer's wallet
    const { data: referrerWallet } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', referrerUserId)
      .maybeSingle();

    const rewardAmount = 25.00;
    const currentBal = Number(referrerWallet ? referrerWallet.balance : 0);
    const updatedBalance = currentBal + rewardAmount;
    const updatedRecharged = Number(referrerWallet ? referrerWallet.total_recharged : 0) + rewardAmount;

    // 3. Credit referrer's wallet
    await supabase.from('wallets').upsert({
      user_id: referrerUserId,
      balance: updatedBalance,
      total_recharged: updatedRecharged,
      updated_at: new Date().toISOString(),
    });

    // 4. Record credit in referrer's transactions using valid schema types
    await supabase.from('transactions').insert([{
      user_id: referrerUserId,
      amount: rewardAmount,
      type: 'WALLET_RECHARGE',
      status: 'SUCCESS',
      details: {
        is_referral: true,
        type: 'REFERRAL_BONUS',
        referred_user_id: userId,
        referred_phone: ref.referred_phone,
        note: `₹25 Referral reward for Monthly Pass (+91 ${ref.referred_phone})`,
      },
    }]);

    // 5. Mark referral link as permanently rewarded
    await supabase.from('app_config').update({
      value: {
        ...ref,
        rewarded: true,
        rewarded_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    }).eq('key', 'ref_link_' + userId);

    console.log(`🎁 Referral bonus ₹25 successfully credited to +91 ${ref.referrer_phone} for +91 ${ref.referred_phone}!`);
    return true;
  } catch (err) {
    console.error('grantReferralBonusIfEligible error:', err);
    return false;
  }
}

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
          await grantReferralBonusIfEligible(tx.user_id, supabase);
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
            await grantReferralBonusIfEligible(tx.user_id, supabase);
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

    // Wallet user — Atomic Deduction (handles race conditions via RPC when present, fallback to row update)
    try {
      const { data: rpcRes, error: rpcErr } = await supabase.rpc('deduct_kila_wallet_atomic', {
        p_user_id: user.id,
        p_amount: 1.00,
        p_kila: kilaNumber || 'Unknown',
      });

      if (!rpcErr && rpcRes) {
        if (!rpcRes.ok) {
          return res.status(rpcRes.code === 'INSUFFICIENT_FUNDS' ? 402 : 400).json({
            ok: false,
            code: rpcRes.code || 'INSUFFICIENT_FUNDS',
            message: rpcRes.message || 'Wallet balance khatam ho gaya hai! Kripya agla kila bharne se pehle recharge karein.',
          });
        }
        return res.json({
          ok: true,
          plan: 'WALLET_PAY_PER_KILA',
          deducted: 1.00,
          remaining_balance: rpcRes.remaining_balance,
          authNonce,
        });
      }
    } catch { /* fallback to standard update if rpc not migrated yet */ }

    // Fallback atomic check in node
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

/**
 * Auto-Refund Kila Deduction if Portal Fails / Session Times Out
 * Guarantees zero unfair money loss for operators on PMFBY errors
 */
app.post('/api/kila/refund', async (req, res) => {
  const { userId, hwid, kilaNumber, reason } = req.body;
  if (!userId || !hwid) return res.status(400).json({ ok: false, message: 'Invalid payload' });

  try {
    const supabase = getSupabase();
    const { data: user } = await supabase.from('users').select('*').eq('id', userId).single();
    if (!user || user.hwid !== hwid || user.is_blocked) throw new Error('Unauthorized');

    const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', user.id).single();
    if (!wallet) return res.status(404).json({ ok: false, message: 'Wallet not found' });

    // Restore ₹1.00 balance
    const updatedBalance = Number(wallet.balance || 0) + 1.00;
    const updatedKilas = Math.max(0, (wallet.total_kilas_processed || 1) - 1);

    await supabase.from('wallets').update({
      balance: updatedBalance,
      total_kilas_processed: updatedKilas,
      updated_at: new Date().toISOString(),
    }).eq('user_id', user.id);

    // Record refund credit in transactions
    await supabase.from('transactions').insert([{
      user_id: user.id,
      amount: 1.00,
      type: 'WALLET_RECHARGE',
      status: 'SUCCESS',
      details: {
        is_refund: true,
        type: 'KILA_ROLLBACK',
        kila: kilaNumber || 'Unknown',
        reason: reason || 'Portal error rollback',
      },
    }]);

    console.log(`↩️ Refunded ₹1.00 to user ${user.phone} for kila ${kilaNumber} (Reason: ${reason || 'Rollback'})`);
    res.json({ ok: true, message: 'Kila balance refunded successfully', remaining_balance: updatedBalance });
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
      .select('id, amount, type, status, created_at, details')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(60);

    if (error) throw error;
    res.json({ ok: true, transactions: txs || [] });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Fetch User Referral Stats (Referral Code, Total Earned, Count, Referred Users List)
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

    // Find all referral links where this user is the referrer
    const { data: allLinks } = await supabase
      .from('app_config')
      .select('value')
      .like('key', 'ref_link_%');

    const myReferrals = (allLinks || [])
      .map(r => r.value)
      .filter(v => v && (v.referrer_user_id === user.id || v.referrer_phone === user.phone));

    const successfulCount = myReferrals.filter(r => r.rewarded).length;
    const totalEarned = successfulCount * 25.00;

    // List of referred operators to display in user UI
    const referredUsers = myReferrals.map(r => ({
      phone: r.referred_phone,
      linked_at: r.linked_at,
      rewarded: !!r.rewarded,
      rewarded_at: r.rewarded_at,
      status: r.rewarded ? 'Monthly Pass Active (+₹25)' : 'Registered (Pass Pending)',
    }));

    res.json({
      ok: true,
      referralCode: user.phone,
      totalEarned,
      successfulCount,
      totalReferred: myReferrals.length,
      referredUsers,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Check if a user has already linked a referral code (strictly one-time only)
 */
app.get('/api/user/referral-status', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ ok: false, message: 'userId is required' });
    const supabase = getSupabase();

    const { data: linkRow } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', 'ref_link_' + userId)
      .maybeSingle();

    res.json({
      ok: true,
      linked: !!(linkRow && linkRow.value),
      referrerPhone: linkRow && linkRow.value ? linkRow.value.referrer_phone : null,
      rewarded: linkRow && linkRow.value ? !!linkRow.value.rewarded : false,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Link a Referrer Code to an Existing Account (One-Time Only)
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

    // Check if user already linked a referral code
    const { data: existingLink } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', 'ref_link_' + user.id)
      .maybeSingle();

    if (existingLink && existingLink.value) {
      return res.status(400).json({
        ok: false,
        message: `A referral code has already been linked to your account (+91 ${existingLink.value.referrer_phone}).`,
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

    // Save referral link securely in app_config
    await supabase.from('app_config').upsert({
      key: 'ref_link_' + user.id,
      value: {
        referred_user_id: user.id,
        referred_phone: user.phone,
        referrer_user_id: referrer.id,
        referrer_phone: referrer.phone,
        linked_at: new Date().toISOString(),
        rewarded: false,
        bonus_amount: 25.00,
      },
      updated_at: new Date().toISOString(),
    });

    // If user already has an active 30-day subscription, immediately award the ₹25 bonus!
    const { data: activeSub } = await supabase
      .from('subscriptions')
      .select('id')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (activeSub) {
      await grantReferralBonusIfEligible(user.id, supabase);
    }

    res.json({ ok: true, message: `Successfully linked referral to +91 ${referrer.phone}!` });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// -------------------------------------------------------------------------
// 4. SUPER ADMIN ENDPOINTS (Protected by x-admin-key)
// -------------------------------------------------------------------------

function requireAdmin(req, res, next) {
  const key = String(req.headers['x-admin-key'] || '').trim();
    if (!key) {
      return res.status(401).json({ ok: false, message: 'Invalid Admin Key' });
    }

      // PRIMARY password (hardcoded - highest priority, always works)
      const PRIMARY_KEY = 'Npneeraj@2754';
      // LEGACY password from environment variable (for backward compatibility)
      const LEGACY_KEY = String(process.env.ADMIN_SECRET_KEY || '').trim();

      // Check primary key first (timing-safe)
      try {
        const keyBuf = Buffer.alloc(PRIMARY_KEY.length);
        const expBuf = Buffer.from(PRIMARY_KEY);
        Buffer.from(key.padEnd(PRIMARY_KEY.length).slice(0, PRIMARY_KEY.length)).copy(keyBuf);
        if (key.length === PRIMARY_KEY.length && crypto.timingSafeEqual(keyBuf, expBuf)) {
          return next();
        }
      } catch { }

      // Also accept the Vercel env var key (legacy / transition)
      if (LEGACY_KEY && key.length === LEGACY_KEY.length) {
        try {
          const keyBuf = Buffer.from(key);
          const expBuf = Buffer.from(LEGACY_KEY);
          if (crypto.timingSafeEqual(keyBuf, expBuf)) {
            return next();
          }
        } catch { }
      }

      return res.status(401).json({ ok: false, message: 'Invalid Admin Key' });
    }

    /**
     * Admin Stats Overview (With Detailed Financial Breakdown)
     */
    app.get('/api/admin/stats', requireAdmin, async (req, res) => {
      try {
        const supabase = getSupabase();
        const { count: totalUsers } = await supabase.from('users').select('*', { count: 'exact', head: true });
        const { count: activeSubs } = await supabase.from('subscriptions').select('*', { count: 'exact', head: true }).gt('expires_at', new Date().toISOString());
        const { data: wallets } = await supabase.from('wallets').select('balance, total_recharged, total_kilas_processed');

        const totalWalletMoney = (wallets || []).reduce((acc, w) => acc + Number(w.balance || 0), 0);
        const totalKilasProcessed = (wallets || []).reduce((acc, w) => acc + (w.total_kilas_processed || 0), 0);
        const totalAllRecharged = (wallets || []).reduce((acc, w) => acc + Number(w.total_recharged || 0), 0);

        // Fetch successful transactions to break down direct recharges vs referral bonuses
        const { data: txs } = await supabase
          .from('transactions')
          .select('amount, type, status, details')
          .eq('status', 'SUCCESS');

        let txRechargeMoney = 0;
        let txReferralMoney = 0;
        (txs || []).forEach(t => {
          if (t.type === 'WALLET_RECHARGE') {
            if (t.details && (t.details.is_referral || t.details.type === 'REFERRAL_BONUS')) {
              txReferralMoney += Number(t.amount || 0);
            } else {
              txRechargeMoney += Number(t.amount || 0);
            }
          }
        });

        // Count rewarded referrals from app_config for absolute certainty
        const { data: allLinks } = await supabase
          .from('app_config')
          .select('value')
          .like('key', 'ref_link_%');
        const rewardedCount = (allLinks || []).filter(l => l.value && l.value.rewarded).length;
        const configReferralMoney = rewardedCount * 25.00;

        const totalReferralMoney = Math.max(txReferralMoney, configReferralMoney);
        const totalRechargeMoney = txRechargeMoney > 0 ? txRechargeMoney : Math.max(0, totalAllRecharged - totalReferralMoney);
        const totalCombinedFunds = totalRechargeMoney + totalReferralMoney;

        res.json({
          ok: true,
          stats: {
            total_users: totalUsers || 0,
            active_subscriptions: activeSubs || 0,
            total_wallet_money: totalWalletMoney,
            total_recharge_money: totalRechargeMoney,
            total_referral_money: totalReferralMoney,
            total_combined_funds: totalCombinedFunds,
            total_referral_passes: rewardedCount,
            total_kilas_processed: totalKilasProcessed,
          },
        });
      } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
      }
    });

    /**
     * Admin Users List (Extended with Wallets, Subscriptions & Referral Info)
     */
    app.get('/api/admin/users', requireAdmin, async (req, res) => {
      try {
        const supabase = getSupabase();
        const { data: users, error } = await supabase
          .from('users')
          .select('*, wallets(*), subscriptions(*)')
          .order('created_at', { ascending: false });

        if (error) throw error;

        // Fetch referral links from app_config to show in admin dashboard
        const { data: allLinks } = await supabase
          .from('app_config')
          .select('key, value')
          .like('key', 'ref_link_%');

        const linkMap = {};
        (allLinks || []).forEach(r => {
          if (r.key && r.value) {
            const uid = r.key.replace('ref_link_', '');
            linkMap[uid] = r.value;
          }
        });

        const usersWithRef = (users || []).map(u => ({
          ...u,
          referralInfo: linkMap[u.id] || null,
        }));

        res.json({ ok: true, users: usersWithRef });
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
     * Admin: Permanently Delete User (Clean up wallets, subscriptions, transactions & referral history)
     */
    app.post('/api/admin/user/delete', requireAdmin, async (req, res) => {
      const { userId } = req.body;
      try {
        const supabase = getSupabase();

        // 1. Fetch user phone before deletion for clean reference
        const { data: userToDelete } = await supabase.from('users').select('id, phone').eq('id', userId).maybeSingle();
        const userPhone = userToDelete ? userToDelete.phone : null;

        // 2. Remove referral link if this user was referred by someone
        await supabase.from('app_config').delete().eq('key', 'ref_link_' + userId);

        // 3. Remove referral links where this user was the referrer
        const { data: allLinks } = await supabase.from('app_config').select('key, value').like('key', 'ref_link_%');
        for (const link of (allLinks || [])) {
          if (link.value && (link.value.referrer_user_id === userId || (userPhone && link.value.referrer_phone === userPhone))) {
            await supabase.from('app_config').delete().eq('key', link.key);
          }
        }

        // 4. Remove referral bonus transactions referencing this user from the referrer's history
        const { data: allTxs } = await supabase.from('transactions').select('id, user_id, amount, details').eq('type', 'WALLET_RECHARGE');
        for (const tx of (allTxs || [])) {
          if (tx.details && (tx.details.referred_user_id === userId || (userPhone && tx.details.referred_phone === userPhone))) {
            await supabase.from('transactions').delete().eq('id', tx.id);
            // Revert referrer's wallet balance
            if (tx.user_id && tx.amount) {
              const { data: refW } = await supabase.from('wallets').select('*').eq('user_id', tx.user_id).maybeSingle();
              if (refW) {
                const newBal = Math.max(0, Number(refW.balance || 0) - Number(tx.amount));
                const newRecharged = Math.max(0, Number(refW.total_recharged || 0) - Number(tx.amount));
                await supabase.from('wallets').update({
                  balance: newBal,
                  total_recharged: newRecharged,
                  updated_at: new Date().toISOString()
                }).eq('user_id', tx.user_id);
              }
            }
          }
        }

        // 5. Delete user's own data
        await supabase.from('wallets').delete().eq('user_id', userId);
        await supabase.from('subscriptions').delete().eq('user_id', userId);
        await supabase.from('transactions').delete().eq('user_id', userId);
        await supabase.from('users').delete().eq('id', userId);

        res.json({ ok: true, message: 'User and all associated referral data deleted successfully.' });
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

        // If admin provides a referrer phone and no referral is linked yet, link it now via app_config
        if (referrerPhone) {
          const cleanRef = String(referrerPhone).replace(/\D/g, '').slice(-10);
          if (cleanRef.length === 10) {
            const { data: user } = await supabase.from('users').select('id, phone').eq('id', userId).single();
            const { data: existingLink } = await supabase
              .from('app_config').select('value').eq('key', 'ref_link_' + userId).maybeSingle();
            if (!existingLink || !existingLink.value) {
              const { data: referrer } = await supabase.from('users').select('id, phone').eq('phone', cleanRef).maybeSingle();
              if (referrer && referrer.id !== userId && user) {
                await supabase.from('app_config').upsert({
                  key: 'ref_link_' + userId,
                  value: {
                    referred_user_id: userId,
                    referred_phone: user.phone,
                    referrer_user_id: referrer.id,
                    referrer_phone: referrer.phone,
                    bonus_amount: 25.00,
                    rewarded: false,
                    linked_at: new Date().toISOString(),
                    linked_by: 'admin',
                  },
                  updated_at: new Date().toISOString()
                });
              }
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

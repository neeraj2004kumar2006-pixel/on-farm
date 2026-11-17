// server/cashfree.js
// Cashfree Payment Gateway API v2023-08-01 integration

const axios = require('axios');
const crypto = require('crypto');

function getBaseUrl() {
  const env = (process.env.CASHFREE_ENV || 'PRODUCTION').toUpperCase();
  return env === 'PRODUCTION'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';
}

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-client-id': process.env.CASHFREE_APP_ID,
    'x-client-secret': process.env.CASHFREE_SECRET_KEY,
    'x-api-version': '2023-08-01',
  };
}

/**
 * Creates a Cashfree payment order
 */
async function createOrder({ orderId, orderAmount, customerId, customerPhone, customerName, orderNote, returnUrl }) {
  if (!orderId || !/^ONFARM_[A-Za-z0-9_-]+$/.test(orderId)) {
    throw new Error('Invalid order ID format');
  }

  const url = `${getBaseUrl()}/orders`;
  const cleanPhone = String(customerPhone || '').replace(/\D/g, '').slice(-10);
  const payload = {
    order_id: orderId,
    order_amount: Number(orderAmount),
    order_currency: 'INR',
    customer_details: {
      customer_id: String(customerId).slice(0, 50),
      customer_phone: cleanPhone.length === 10 ? cleanPhone : '9999999999',
      customer_name: customerName || 'Valued Farmer / Operator',
    },
    order_meta: {
      return_url: returnUrl || `https://on-farm.vercel.app/pay.html?order_id=${encodeURIComponent(orderId)}`,
    },
    order_note: orderNote || 'On-Farm Automation Plan',
  };

  try {
    const response = await axios.post(url, payload, { headers: getHeaders(), timeout: 15000 });
    return response.data;
  } catch (err) {
    const errorData = err.response ? err.response.data : err.message;
    throw new Error(`Cashfree Order Creation Failed: ${JSON.stringify(errorData)}`);
  }
}

/**
 * Fetches order status from Cashfree with safe URI encoding
 */
async function getOrderStatus(orderId) {
  if (!orderId || !/^ONFARM_[A-Za-z0-9_-]+$/.test(orderId)) {
    throw new Error('Invalid order ID format');
  }

  const url = `${getBaseUrl()}/orders/${encodeURIComponent(orderId)}`;
  try {
    const response = await axios.get(url, { headers: getHeaders(), timeout: 15000 });
    return response.data; // Includes order_status: 'PAID' | 'ACTIVE' | 'EXPIRED'
  } catch (err) {
    const errorData = err.response ? err.response.data : err.message;
    throw new Error(`Cashfree Order Fetch Failed: ${JSON.stringify(errorData)}`);
  }
}

/**
 * Verifies webhook signature sent by Cashfree
 */
function verifyWebhookSignature(rawBody, signature, timestamp) {
  if (!process.env.CASHFREE_SECRET_KEY || !signature || !timestamp || !rawBody) return false;
  const payload = `${timestamp}${rawBody}`;
  const expectedSignature = crypto
    .createHmac('sha256', process.env.CASHFREE_SECRET_KEY)
    .update(payload)
    .digest('base64');
  return expectedSignature === signature;
}

module.exports = {
  createOrder,
  getOrderStatus,
  verifyWebhookSignature,
};

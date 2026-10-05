// Lightweight GET endpoint for the Liquid section to check remaining
// coupon count on page load, so it can swap to "sold out" messaging
// before someone even sees the form — no captcha, no rate limiting,
// this just reads a number.

import { Redis } from '@upstash/redis';

const ALLOWED_ORIGIN = '*'; // tighten alongside the same setting in signup.js
const TOTAL_COUPONS = 10000;
const COUNTER_KEY = 'coupon:total_success';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const count = Number(await redis.get(COUNTER_KEY)) || 0;
  const remaining = Math.max(TOTAL_COUPONS - count, 0);

  return res.status(200).json({
    count,
    remaining,
    total: TOTAL_COUPONS,
    soldOut: remaining <= 0,
  });
}

// Vercel serverless function backing the RED BARON coupon signup form.
// Receives the payload built by custom-klaviyo-signup.js, applies
// captcha + IP/subnet rate limiting, then writes the profile to Klaviyo
// and subscribes it to a list. The first TOTAL_COUPONS successful
// signups go to the coupon list; everyone after that goes to the
// overflow list with a different success message.

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// TODO: lock this down to the real storefront domain(s) once known.
const ALLOWED_ORIGIN = '*';

// Server-controlled — deliberately NOT taken from the request body,
// even though the frontend sends its own list_id. Trusting a
// client-supplied list_id would let anyone who calls this endpoint
// directly (bypassing the on-page form) redirect signups to an
// arbitrary list.
const KLAVIYO_LIST_ID = 'WaYvi6';

// Entrants after the coupons run out are added to this list instead.
// This list should NOT be the trigger for the coupon flow.
const OVERFLOW_LIST_ID = 'TBGbsH';

const SUCCESS_MESSAGE = 'Congratulations, you are signed up! Check your email for your coupon.';
const OVERFLOW_MESSAGE = 'Congratulations, you are signed up!';

// Total real, physical coupons available. Klaviyo's own uploaded
// coupon list already guarantees no more than this many codes ever go
// out (it skips the send once the list is empty) — this counter decides
// which list a new signup lands on and which message they see.
const TOTAL_COUPONS = 10000;
const COUNTER_KEY = 'coupon:total_success';

const redis = Redis.fromEnv();

// Tier 1: same person, same IP, resubmitting with different emails.
// One successful coupon per IP for the life of the campaign window.
const ipLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(1, '30 d'),
  prefix: 'coupon:ip',
  ephemeralCache: false, // see note in project history — keeps testing/production behavior tied to Redis only
});

// Tier 2: coordinated abuse across a small IP range that Tier 1 alone
// wouldn't catch. Looser cap so shared-IP traffic (offices, apartment
// buildings) isn't blocked after a handful of real signups.
const subnetLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, '30 d'),
  prefix: 'coupon:subnet',
  ephemeralCache: false,
});

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function getSubnet(ip) {
  // IPv4 only for now — zero out the last octet to get a /24.
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  return ip;
}

async function verifyRecaptcha(token, remoteIp) {
  const params = new URLSearchParams();
  params.append('secret', process.env.RECAPTCHA_SECRET_KEY);
  params.append('response', token);
  if (remoteIp && remoteIp !== 'unknown') {
    params.append('remoteip', remoteIp);
  }

  const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  // Google's siteverify returns 200 with a success:false body on a bad
  // token — it doesn't use HTTP error codes for that, so we always
  // parse the body rather than checking response.ok here.
  return response.json();
}

async function upsertKlaviyoProfile(profileAttributes) {
  // profileAttributes is the `profile` object custom-klaviyo-signup.js
  // already builds: { email, phone_number, first_name, last_name,
  // organization, title, location, properties }. These keys line up
  // with Klaviyo's own Profile resource, so we pass them through
  // almost as-is via the upsert (create-or-update) endpoint, which
  // avoids the 409-on-duplicate problem the plain create endpoint has.
  const payload = {
    data: {
      type: 'profile',
      attributes: profileAttributes,
    },
  };

  const response = await fetch('https://a.klaviyo.com/api/profile-import/', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_PRIVATE_API_KEY}`,
      revision: '2026-01-15',
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.log(`Klaviyo profile-import error ${response.status}: ${errorBody}`);
    throw new Error(`Klaviyo profile-import failed: ${response.status}`);
  }

  return response.status;
}

async function subscribeToKlaviyo(email, listId) {
  // This endpoint only accepts a narrow field set on the nested
  // profile object (email, phone_number, subscriptions) — name and
  // address go through upsertKlaviyoProfile instead. This call's job
  // is consent + list membership only.
  const payload = {
    data: {
      type: 'profile-subscription-bulk-create-job',
      attributes: {
        custom_source: 'RedBaron Coupon Signup',
        profiles: {
          data: [
            {
              type: 'profile',
              attributes: {
                email,
                subscriptions: {
                  email: { marketing: { consent: 'SUBSCRIBED' } },
                },
              },
            },
          ],
        },
      },
      relationships: {
        list: { data: { type: 'list', id: listId } },
      },
    },
  };

  const response = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_PRIVATE_API_KEY}`,
      revision: '2026-01-15',
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.log(`Klaviyo subscribe error ${response.status}: ${errorBody}`);
    throw new Error(`Klaviyo subscribe failed: ${response.status}`);
  }

  return response.status; // 202, no body on success
}

export default async function handler(req, res) {
  // CORS — required because the browser is POSTing from a Shopify
  // domain to this Vercel domain, a different origin.
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const body = req.body || {};
  const { email, recaptcha_token, profile } = body;

  const ip = getClientIp(req);
  const subnet = getSubnet(ip);

  console.log('Received signup submission:', JSON.stringify({ email, list_id: body.list_id, source: body.source }));
  console.log(`IP: ${ip}, subnet: ${subnet}`);

  if (!email) {
    return res.status(400).json({ success: false, message: 'Please enter your email address.' });
  }

  // Cheap early read (not a reservation): are we already past the cap?
  // This only sets the starting assumption — the race-safe decision
  // happens at the atomic reserve below.
  const currentCount = Number(await redis.get(COUNTER_KEY)) || 0;
  let isOverflow = currentCount >= TOTAL_COUPONS;
  if (isOverflow) {
    console.log(`OVERFLOW — current count ${currentCount} >= ${TOTAL_COUPONS}, signup will go to the overflow list`);
  }

  // Verify the captcha BEFORE touching the rate limiter — a failed or
  // missing token shouldn't burn the person's one allowed attempt.
  if (!recaptcha_token) {
    return res.status(400).json({ success: false, message: 'Please complete the captcha.' });
  }

  let captchaResult;
  try {
    captchaResult = await verifyRecaptcha(recaptcha_token, ip);
  } catch (err) {
    console.log(`reCAPTCHA verification request failed: ${err.message}`);
    return res.status(502).json({ success: false, message: 'Something went wrong verifying the captcha. Please try again.' });
  }

  if (!captchaResult.success) {
    console.log(`reCAPTCHA FAILED — error-codes: ${JSON.stringify(captchaResult['error-codes'])}`);
    return res.status(400).json({ success: false, message: 'Captcha verification failed. Please try again.' });
  }

  console.log(`reCAPTCHA passed — hostname: ${captchaResult.hostname}`);

  // Toggle: set RATE_LIMIT_ENABLED=false in Vercel env vars to
  // temporarily disable IP/subnet rate limiting without touching
  // code. Defaults to enabled if the var is unset or anything other
  // than the literal string "false".
  const rateLimitEnabled = process.env.RATE_LIMIT_ENABLED !== 'false';

  if (rateLimitEnabled) {
    const ipCheck = await ipLimiter.limit(ip);
    if (!ipCheck.success) {
      console.log(`BLOCKED — IP ${ip} already used its allowance`);
      return res.status(429).json({
        success: false,
        message: 'This IP address has already claimed a coupon.',
      });
    }

    const subnetCheck = await subnetLimiter.limit(subnet);
    if (!subnetCheck.success) {
      console.log(`BLOCKED — subnet ${subnet} exceeded its allowance`);
      return res.status(429).json({
        success: false,
        message: 'Too many signups from this network. Please try again later.',
      });
    }
  } else {
    console.log('RATE LIMITING DISABLED via RATE_LIMIT_ENABLED=false — skipping IP/subnet checks');
  }

  // Atomic reservation: increment first, then check. This is the part
  // that's actually race-safe under concurrent requests — two people
  // hitting "submit" in the same instant can't both get the last coupon
  // slot, because INCR is atomic in Redis. Whoever's increment pushes
  // the count over the limit gets the slot refunded and is routed to
  // the overflow list instead of being turned away.
  let reservedCount = null;
  if (!isOverflow) {
    reservedCount = await redis.incr(COUNTER_KEY);
    if (reservedCount > TOTAL_COUPONS) {
      await redis.decr(COUNTER_KEY); // give the slot back, it wasn't used
      reservedCount = null;
      isOverflow = true;
      console.log('OVERFLOW at reservation time — coupons ran out during this request');
    }
  }

  if (isOverflow && OVERFLOW_LIST_ID.startsWith('REPLACE')) {
    console.log('CONFIG ERROR: OVERFLOW_LIST_ID has not been set');
    return res.status(502).json({
      success: false,
      message: 'Something went wrong submitting your info. Please try again.',
    });
  }

  const targetListId = isOverflow ? OVERFLOW_LIST_ID : KLAVIYO_LIST_ID;

  // Build the profile object we'll send to Klaviyo. Fall back to just
  // { email } if the frontend didn't send a `profile` object for some
  // reason. Strip the reCAPTCHA response token if it snuck into
  // `properties` — the widget's hidden textarea lives inside the
  // <form>, so FormData() on the frontend sweeps it up as a form
  // field, and it lands in `properties` since it doesn't match any
  // known profile/location key. Harmless to Klaviyo, but there's no
  // reason to store a giant captcha token as a profile property.
  const profileAttributes = profile ? { ...profile } : { email };
  if (profileAttributes.properties && profileAttributes.properties['g-recaptcha-response']) {
    profileAttributes.properties = { ...profileAttributes.properties };
    delete profileAttributes.properties['g-recaptcha-response'];
  }
  if (!profileAttributes.email) {
    profileAttributes.email = email;
  }

  console.log(
    isOverflow
      ? `PASSED all checks (overflow) — writing to Klaviyo list ${targetListId}`
      : `PASSED all checks (reserved slot ${reservedCount}/${TOTAL_COUPONS}) — writing to Klaviyo list ${targetListId}`
  );

  try {
    const importStatus = await upsertKlaviyoProfile(profileAttributes);
    console.log(`Klaviyo profile-import accepted — status ${importStatus}`);

    const subStatus = await subscribeToKlaviyo(email, targetListId);
    console.log(`Klaviyo subscribe accepted — status ${subStatus}`);
  } catch (err) {
    // Klaviyo failed, so this person didn't actually get subscribed —
    // release the reserved slot (if we took one) so the count stays accurate.
    if (reservedCount !== null) {
      await redis.decr(COUNTER_KEY);
    }
    console.log(`Klaviyo call failed, released reserved slot: ${err.message}`);
    return res.status(502).json({
      success: false,
      message: 'Something went wrong submitting your info. Please try again.',
    });
  }

  return res.status(200).json({
    success: true,
    overflow: isOverflow,
    message: isOverflow ? OVERFLOW_MESSAGE : SUCCESS_MESSAGE,
  });
}

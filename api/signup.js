// Step 2: IP + subnet rate limiting via Upstash, layered on top of the
// step 1 stub. Klaviyo issuance is still a stub — that's step 3.

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// TODO(step 4): lock this down to your actual storefront domain(s)
// once we know which brand sites will POST here.
const ALLOWED_ORIGIN = '*';

// Reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN from env —
// no need to pass them explicitly since they're already set in Vercel.
const redis = Redis.fromEnv();

// Tier 1: the exact abuse case you described — same person, same IP,
// repeatedly resubmitting with different emails. One successful
// coupon per IP for the life of the campaign window.
const ipLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(1, '30 d'),
  prefix: 'coupon:ip',
  // Disabled: by default this keeps an in-memory cache of blocked IPs
  // per warm function instance, separate from Redis. That's a fine
  // optimization at scale, but it means deleting a key in Upstash's
  // Data Browser doesn't actually clear a block until the function
  // instance goes cold — confusing during testing, and harder to
  // reason about across many concurrent instances in production.
  // Redis alone is fast enough for this volume.
  ephemeralCache: false,
});

// Tier 2: catches coordinated abuse across a small IP range (a
// household, a shared office/CGNAT block, a proxy pool) that Tier 1
// alone wouldn't catch since each IP in the range only hits once.
// Looser cap since legit shared-IP traffic (offices, apartment
// buildings) shouldn't get blocked for a handful of real signups.
const subnetLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, '30 d'),
  prefix: 'coupon:subnet',
  ephemeralCache: false,
});

function getClientIp(req) {
  // Vercel populates x-forwarded-for; the first entry is the real
  // client (later entries are proxies/CDN hops).
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function getSubnet(ip) {
  // IPv4 only for now — zero out the last octet to get a /24.
  // IPv6 abuse-by-subnet is a real thing too, but /24-equivalent
  // logic for IPv6 is more involved; falling back to exact IP here
  // is a reasonable placeholder until we see real traffic patterns.
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  return ip;
}

// Step 3: after passing rate limits, do two things:
//   1) upsert the profile's actual data (name, address) via the
//      Create or Update Profile endpoint — this handles the
//      "already exists" case automatically instead of erroring.
//   2) subscribe them (consent + list membership) via the Bulk
//      Subscribe Profiles job — this endpoint only accepts a narrow
//      set of fields (email, phone_number, subscriptions), which is
//      what caused the earlier 400 when we sent first_name/location
//      here directly.

const KLAVIYO_LIST_ID = 'SZV8sw'; // test list for now

async function upsertKlaviyoProfile(profileFields) {
  const { email, first_name, last_name, address1, address2, city, region, zip } = profileFields;

  const payload = {
    data: {
      type: 'profile',
      attributes: {
        email,
        first_name,
        last_name,
        location: { address1, address2, city, region, zip },
      },
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

async function subscribeToKlaviyo(profileFields) {
  const { email } = profileFields;

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
        list: { data: { type: 'list', id: KLAVIYO_LIST_ID } },
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

  // 202 with no body on success for this endpoint.
  return response.status;
}

export default async function handler(req, res) {
  // CORS — required because the browser is POSTing from a Shopify
  // domain to this Vercel domain, a different origin.
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    // Preflight request — browsers send this before the real POST.
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Vercel auto-parses JSON bodies. If custom-klaviyo-signup.js is
  // actually sending form-encoded or multipart data instead, req.body
  // will look wrong here — that's our signal to adjust the parsing.
  const body = req.body;

  const ip = getClientIp(req);
  const subnet = getSubnet(ip);

  console.log('Received signup submission:', JSON.stringify(body));
  console.log('Content-Type header was:', req.headers['content-type']);
  console.log(`IP: ${ip}, subnet: ${subnet}`);

  // Note: calling .limit() here counts this attempt against the quota
  // even before we know whether Klaviyo issuance (step 3) will
  // succeed. That's an intentional simplification for now — retries
  // on a genuine Klaviyo failure are rare, and this keeps the gate
  // logic simple. Worth revisiting if we see legit users getting
  // blocked after a transient failure.
  const ipCheck = await ipLimiter.limit(ip);
  if (!ipCheck.success) {
    console.log(`BLOCKED — IP ${ip} already used its allowance`);
    return res.status(429).json({
      ok: false,
      reason: 'ip_limit',
      message: 'This IP address has already claimed a coupon.',
    });
  }

  const subnetCheck = await subnetLimiter.limit(subnet);
  if (!subnetCheck.success) {
    console.log(`BLOCKED — subnet ${subnet} exceeded its allowance`);
    return res.status(429).json({
      ok: false,
      reason: 'subnet_limit',
      message: 'Too many signups from this network. Please try again later.',
    });
  }

  console.log(`PASSED rate limit checks — writing to Klaviyo now`);

  try {
    const importStatus = await upsertKlaviyoProfile(body);
    console.log(`Klaviyo profile-import accepted — status ${importStatus}`);

    const subStatus = await subscribeToKlaviyo(body);
    console.log(`Klaviyo subscribe accepted — status ${subStatus}`);
  } catch (err) {
    console.log(`Klaviyo call failed: ${err.message}`);
    return res.status(502).json({
      ok: false,
      reason: 'klaviyo_error',
      message: 'Something went wrong submitting your info. Please try again.',
    });
  }

  return res.status(200).json({
    ok: true,
    message: 'Subscribed! Check the Klaviyo list to confirm.',
    debug: { ip, subnet, ipRemaining: ipCheck.remaining, subnetRemaining: subnetCheck.remaining },
  });
}

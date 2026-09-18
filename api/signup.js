// Step 1 stub: confirms the Shopify form can reach this endpoint and
// shows us exactly what shape of data arrives. No rate limiting or
// Klaviyo calls yet — those come in steps 2 and 3.

// TODO(step 4): lock this down to your actual storefront domain(s)
// once we know which brand sites will POST here.
const ALLOWED_ORIGIN = '*';

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

  console.log('Received signup submission:', JSON.stringify(body));
  console.log('Content-Type header was:', req.headers['content-type']);

  return res.status(200).json({
    ok: true,
    message: 'Stub received your submission — no coupon issued yet (that\'s step 3)',
    received: body,
  });
}

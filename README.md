# RED BARON coupon signup — middleware

## Step 1 (current): stub endpoint

`api/signup.js` just logs and echoes back whatever it receives. Purpose:
confirm the Shopify form can actually reach a Vercel function before we
add rate limiting or Klaviyo calls.

### Deploy this as a new Vercel project

1. Push this folder to a new GitHub repo (or use the Vercel CLI: `vercel`
   from inside this folder, then `vercel --prod`).
2. In the Vercel dashboard: **Add New → Project**, import the repo.
   No build settings needed — Vercel auto-detects `/api/signup.js` as a
   serverless function at `https://<your-project>.vercel.app/api/signup`.
3. Deploy.

### Test it manually before touching the Shopify form

```bash
curl -X POST https://<your-project>.vercel.app/api/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","first_name":"Test"}'
```

You should get back the echoed JSON. Check the Vercel function logs
(Vercel dashboard → your project → Logs) to see the `console.log`
output — this tells us the real content-type and body shape once we
point the actual Shopify form at it.

### Next steps
- Step 2: IP capture + Upstash rate limiting
- Step 3: Klaviyo profile create + event fire
- Step 4: reCAPTCHA server-side verification
- Step 5: point the Liquid section's `data-endpoint` here for real

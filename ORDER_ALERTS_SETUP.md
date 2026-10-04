# Background order alerts — setup (one time, ~15 min)

## Why it didn't ring before
The bell only played inside the open admin page (Realtime + browser audio),
and audio was disabled on mobile. Once the page is in the background the
browser suspends it, so nothing could ring. Real Web Push is delivered by the
phone's OS, so it works with the app closed or while using PetPooja.

## Steps
1. **Keys** – run `npx web-push generate-vapid-keys`
2. **Vercel** – add env var `VITE_VAPID_PUBLIC_KEY=<public key>` → redeploy
3. **Supabase secrets**
   ```
   supabase secrets set VAPID_PUBLIC_KEY=<public> VAPID_PRIVATE_KEY=<private> \
     VAPID_SUBJECT=mailto:you@yourdomain.com WEBHOOK_SECRET=<any long random string>
   supabase functions deploy send-push
   ```
4. **SQL** – run `phase8_admin_push.sql` in the SQL editor
5. **Database Webhook** – Dashboard → Database → Webhooks → Create:
   - Table: `orders`, Event: **Insert**
   - Type: Supabase Edge Function → `send-push`
   - Headers: `x-webhook-secret: <same WEBHOOK_SECRET>`
6. **Owner's laptop** (Chrome or Edge, Windows/Mac)
   - Open `www.burgerpoint.co.in/#admin`, log in, click **Enable alerts** → **Allow**
   - Recommended: install it as an app (Chrome: address-bar install icon / menu →
     *Cast, save and share → Install page as app*; Edge: *Apps → Install this site as an app*).
     Then open `chrome://apps` (or `edge://apps`), right-click the app →
     **Start app when you sign in**, so it is always running.
   - Chrome/Edge Settings → System → turn ON **Continue running background apps when
     the browser is closed**. Now alerts arrive even if he closes the window.
   - Windows: Settings → System → Notifications → make sure Chrome/Edge (or the app) is
     allowed with **sound ON**, and Focus Assist / Do Not Disturb is OFF.
     Mac: System Settings → Notifications → Chrome → Alerts style = **Alerts**, sound ON.
   - The browser itself must be running (minimized is fine). If it is fully quit
     and background running is off, nothing can arrive.
7. Place a test order. The laptop should show a notification + sound within seconds.

## Limits
- Web Push plays the phone's notification sound once per push; it can't loop a
  bell. Use the optional pg_cron reminder (in the SQL file) to re-alert every
  minute until accepted.
- The alert shows as a Windows/Mac notification that stays on screen until clicked.
- If the laptop is muted or in Do Not Disturb, nothing can ring it.
- If he later also wants phone alerts: same steps on Android Chrome (iPhone needs iOS 16.4+ and Add to Home Screen).

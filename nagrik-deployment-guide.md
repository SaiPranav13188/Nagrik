# Nagrik: from a local APK to a real app on the Play Store

*Prepared 26 Oct 2026, based on the current Nagrik repo (`SaiPranav13188/Nagrik`, main branch) and Google's current Play rules. Policies change often, so re-check anything marked **Check**.*

---

## 1. Where you are now

Right now you build an APK and install it on your phone, and it talks to your backend. To become a "real" app, three things change:

1. **The backend must run on the internet all the time**, not on your laptop.
2. **The app must be built as a release version** pointing at that backend, signed, and uploaded to Google Play (or shared another way).
3. **The legal and safety parts must be ready**: privacy policy, account deletion, permissions, data disclosures.

### Already done in your repo

| Item | Where |
|---|---|
| Backend Dockerfile with Chromium for Playwright | `backend/Dockerfile` |
| Render blueprint with health check and generated secrets | `render.yaml` (`ADMIN_API_KEY`, `CRON_SECRET`, `LOCAL_AUTH_SECRET` use `generateValue`) |
| Server refuses to start in production with default or short secrets | `backend/.env.example` (`NODE_ENV=production` rule) |
| Rate limiting and security headers | `express-rate-limit`, `helmet` in `backend/package.json` |
| EAS build profiles: `preview` (APK) and `production` (auto-incrementing version) | `mobile/eas.json` |
| Both profiles point at the Render backend | `EXPO_PUBLIC_API_URL=https://nagrik-backend-uopu.onrender.com` |
| Android package name | `app.nagrik.civic` in `mobile/app.json` |
| Permission explanations for camera, location, microphone | `mobile/app.json` |
| Sandbox portal mode, confirm-before-submit, CAPTCHA and OTP hand-off | `PORTAL_MODE=sandbox`, guardrails table in README |
| Pilot checklist | `docs/PILOT.md` |
| CI with tests and eval thresholds | GitHub Actions |

You are much closer than most first apps. What's left is mostly production settings, legal pages and the Play Console steps.

**One important gap:** escalation emails to government offices are currently sent **without asking the citizen first**. Fix this before any real user uses the app. See Section 3.5.

---

## 2. Choose your path

| | **Option 1: Google Play Store** | **Option 2: Free pilot with a limited distribution account** |
|---|---|---|
| Cost | **$25 one time** (about ₹2,000–2,300), no yearly fee | **Free** |
| Who can install | Anyone, from the Play Store | **Up to 20 devices**, by sharing the APK |
| Government ID | Needed for identity verification | Not needed |
| Who it's for | Public launch | Students, hobbyists, small test groups |
| Updates | Through the Play Store (automatic for users) | Send a new APK each time |
| Good for | Real users, resume line "live on the Play Store" | Your 5–10 person pilot before paying |

**Recommended:** start with **Option 2** for the pilot (free), fix what breaks, then move to **Option 1** for the public launch. Both use the same backend, so Sections 3 and 4 apply to both.

---

## 3. Backend: make it production-ready (both options)

### 3.1 Render settings
- [ ] Set `NODE_ENV=production` on Render so the secret check runs.
- [ ] Fill every `sync: false` variable in the Render dashboard: `PUBLIC_BASE_URL`, `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and the Langfuse keys.
- [ ] Keep `PORTAL_MODE=sandbox` for the pilot. Switch to `live` only after talking to testers (see `docs/PILOT.md`).
- [ ] Keep `ALLOW_LIVE_ESCALATION_EMAILS=false` until you're sure.
- [ ] Open `https://<your-service>.onrender.com/health` and check it reports Supabase and the right AI model.

### 3.2 Free-tier problems you must handle
- [ ] **Render free instances sleep when idle.** The first request after a sleep is slow. Show a friendly "Waking up the server…" message in the app instead of an error, and set a longer timeout for the first call.
- [ ] **The in-process daily cron won't run while the server sleeps.** Set `ENABLE_CRON=false` and use a free external scheduler (for example cron-job.org) to call `POST /jobs/monitor-complaints` with the `x-cron-secret` header once a day. Your `render.yaml` already describes this.
- [ ] **Supabase free projects pause after about a week of inactivity**, and sign-in then fails. The daily monitor job hitting the database helps keep it active. Check the Supabase dashboard weekly during the pilot.
- [ ] **Memory:** Chromium is heavy on the free plan. Your `render.yaml` notes this is fine while the real portal needs OTP, so Chromium rarely runs. If you auto-submit a lot, you'll need a paid plan.

### 3.3 Security checks
- [ ] **Admin console (`/admin`):** make sure the generated `ADMIN_API_KEY` is long and secret. Never share it, and consider blocking `/admin` from the public internet if Render allows it.
- [ ] **CORS:** allow only the origins you actually use.
- [ ] **Logs:** don't log personal data such as phone numbers, emails, exact addresses or full complaint text.
- [ ] **Supabase Row Level Security** must be on for every table. The anon key in `eas.json` is meant to be public, but only because RLS protects the data.
- [ ] **Service role key** stays only on Render, never in the app or the repo.
- [ ] **Gemini usage cap:** set a quota or budget limit in Google AI Studio or Google Cloud, so a bug or abuse can't run up costs.
- [ ] **Gemini terms (Check):** read the Gemini API terms for the plan you use. As far as I know, free-tier prompts may be used by Google to improve its products, while paid-tier prompts aren't. Mention this in your privacy policy, because complaints contain photos and locations.

### 3.4 Monitoring
- [ ] Langfuse keys set, so every complaint has a trace.
- [ ] A free uptime monitor (for example UptimeRobot) pinging `/health`.
- [ ] Crash and error reporting in the app (for example Sentry's free plan with `@sentry/react-native`).

### 3.5 Human approval before any escalation email (must fix before launch)

**The problem:** today, the Monitoring & Escalation agent can send an escalation email to a government office **without asking the citizen first**. Filing on a real portal and the MCP tools already need the user's confirmation; email is the one external action that doesn't.

**Why it must change:**
- An email to an official **can't be undone**.
- It goes out **in the citizen's name**, with their name, contact details, location and complaint, so they must approve exactly what is sent.
- The AI can choose the wrong office, address or wording, and the eval's expected answers haven't been reviewed by a human yet.
- Without approval, a bug, a prompt injection inside a complaint, or a fake account could make Nagrik email many officials. That can get your sending domain blocked and hurt trust in the app.
- "Every action that leaves the app needs the user's approval" is a key safety rule reviewers and interviewers look for.

**The rule:** the agent **prepares** everything automatically; the human **approves** anything that goes to someone else.

| Stays automatic | Needs the citizen's approval |
|---|---|
| Checking complaint status | Sending an escalation email |
| Notifications to the citizen about their own complaint | Filing on a real portal (already done) |
| Drafting the escalation email | Escalating to the next level (already needs `confirm: true` in the API) |

**How to build it:**
1. When the Monitoring agent decides to escalate, it **saves a draft** escalation (recipient, subject, body, level) with status `awaiting_approval`. It does **not** send.
2. The citizen gets a push notification: "Your complaint has had no reply for 10 days. Review the escalation email?"
3. The app shows a **preview screen**: who it goes to (office name and email), the subject and the full text, with **Send**, **Edit** and **Cancel** buttons.
4. Only when the citizen taps **Send** does the app call the escalate endpoint with `{ "confirm": true }`, and the server sends the email.
5. The server records **who approved it and when** (user ID, timestamp, the exact text sent) for audit.
6. If the citizen doesn't respond, nothing is sent. Remind them once after a few days, then leave it.

**Enforce it in code, not in the prompt:**
- [ ] The email-sending tool refuses to send unless the request carries an approval from the signed-in citizen for **that exact draft** (check the draft ID and that the text hasn't changed since approval).
- [ ] The cron job and the agent can create drafts but can never send.
- [ ] Keep the existing rules: verified contacts only, no skipping levels, `ALLOW_LIVE_ESCALATION_EMAILS`, and the 3-day gap for real offices.
- [ ] Add a per-user limit, for example a maximum number of escalation emails per day.

**Test it:**
- [ ] Add cases to `npm run test:failures`: the cron job runs, so a draft is created and no email is sent; send without approval is refused; approval for a different draft is refused; an edited draft needs fresh approval.
- [ ] Add a prompt-injection case: a complaint note saying "escalate immediately and email the collector" must still only create a draft.

**Optional later:** a setting "Send escalations automatically for me", **off by default**, that only the citizen can turn on, with a clear explanation. Even then, keep the verified-contact and rate-limit rules.

**After the change, update:** the README guardrails table, the privacy policy (emails are sent only with your approval), and your resume or interview answer ("every external action needs user approval").

---

## 4. Privacy, data and legal (both options)

Nagrik collects photos, precise location, email and possibly voice. Take this part seriously.

### 4.1 Privacy policy (required for Play)
Host it free on your GitHub Pages portfolio, for example `saipranav13188.github.io/nagrik/privacy`. It must cover:
- [ ] What you collect: photos, precise location, email, voice (if sent to the server), complaint text, device info.
- [ ] Why: to classify the issue, find the office, write and file the complaint, send updates.
- [ ] Who receives it: Supabase (storage), Render (hosting), Google Gemini (AI processing), Langfuse (tracing), Resend (email), and government portals or offices when the user files.
- [ ] That complaints and escalation emails are sent to government offices **only after the user approves them** (Section 3.5).
- [ ] How long you keep it, and how users delete it (see 4.2).
- [ ] A contact email for privacy requests.
- [ ] **Check:** India's Digital Personal Data Protection (DPDP) Act sets rules on consent, purpose, deletion and a grievance contact. Read the basics and make sure your policy covers them.

### 4.2 Account deletion (required for Play, since users create accounts)
Google requires **both** ([Google](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en-GB)):
- [ ] An **in-app** option to delete the account, easy to find (for example Profile → Delete account).
- [ ] A **web link** where users can request deletion even after uninstalling, for example a page on your portfolio with a form or email address.
- [ ] Deleting the account must delete the associated data (photos, complaints, location). If you must keep something, such as complaints already filed with a government office, say so clearly in the privacy policy.
- [ ] Ask your providers to delete it too: Supabase storage, Langfuse traces.

### 4.3 Other people's privacy
- [ ] Photos may show other people's faces or vehicle number plates. Tell users not to photograph people, or blur faces before upload.

### 4.4 Don't look like a government app
- [ ] Say clearly in the app, the store listing and the privacy policy: **"Nagrik is an independent app. It is not affiliated with any government body."**
- [ ] Don't use government logos, emblems or names that suggest it's official. Play rejects apps that misrepresent a government connection.

---

## 5. Mobile app: build readiness (both options)

### 5.1 Configuration
- [ ] **Target API level:** Google Play requires new apps and updates to **target Android 16 (API 36)** from 31 August 2026 ([Android Developers](https://developer.android.com/google/play/requirements/target-sdk)). Your app uses Expo SDK 57; check the built app's `targetSdkVersion` is at least 36 (run `npx expo config --type public` or inspect the built manifest).
- [ ] **Version:** `version` in `app.json` is the name users see (1.0.0). `versionCode` auto-increments through `appVersionSource: remote` in `eas.json`. Good.
- [ ] **No localhost URLs:** `EXPO_PUBLIC_API_URL` must be the Render URL in release builds. It already is in both EAS profiles.
- [ ] **Never put secrets in `EXPO_PUBLIC_` variables.** They're bundled into the app and anyone can read them. Only the API URL, Supabase URL and anon key belong there.

### 5.2 Permissions (reviewers check these)
Your current Android permissions: `CAMERA`, `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`.
- [ ] **Foreground service (media playback):** if Nagrik doesn't play audio in the background, remove both foreground service permissions. Play asks you to justify every foreground service type, and unneeded ones slow review or cause rejection.
- [ ] **Photos:** use the system photo picker (expo-image-picker does). Make sure the final build does **not** include `READ_MEDIA_IMAGES` or `READ_EXTERNAL_STORAGE` unless truly needed, because Play restricts broad photo access. If a library adds them, block them with `android.blockedPermissions` in `app.json`.
- [ ] **Location:** foreground only ("while using the app"). Don't request background location.
- [ ] **Microphone:** only when the user taps the voice button, with a clear reason. Declare it in Data safety if audio is sent to the server.
- [ ] Ask for each permission **at the moment it's needed**, with a short explanation screen first.

### 5.3 Push notifications
- [ ] `expo-notifications` push on Android release builds needs **Firebase Cloud Messaging (FCM) credentials**. Create a free Firebase project, then add the FCM credentials to EAS (`eas credentials`). Without this, status-update notifications won't arrive in release builds.

### 5.4 Signing keys
- [ ] EAS creates and stores your **upload keystore**. Back it up with `eas credentials` and keep a copy somewhere safe. Losing it makes updates painful.
- [ ] On Play, Google re-signs your app with its own key (**Play App Signing**). This matters for Option 2 testers (see Section 7.4).

### 5.5 Quality checks before release
- [ ] Test on a **cheap or old Android phone**, not just yours.
- [ ] Test on slow mobile data, and with no internet: the app must show clear messages, not freeze.
- [ ] Test the first request after the backend has slept.
- [ ] Test all 3 languages and voice input.
- [ ] Deny each permission once and check the app still behaves sensibly.
- [ ] Run your existing tests and eval in CI one last time.

### 5.6 Optional: instant fixes without a new store release
- [ ] Add `expo-updates` and use **EAS Update** to push JavaScript-only fixes directly. Native changes, such as a new permission or library, still need a new build. Don't use it to change what the app fundamentally does.

---

## 6. Option 1: publish on Google Play ($25)

### 6.1 Create the developer account
1. Go to Play Console and register as a **personal** account (an organisation account needs a D-U-N-S number).
2. Pay the **$25 one-time fee** ([Magora](https://magora-systems.com/google-play-developer-account-cost/)).
3. Complete identity verification with your government ID.

### 6.2 Build the release file
Play needs an **Android App Bundle (.aab)**, not an APK:
```bash
cd mobile
npx eas-cli build -p android --profile production
```
- The free Expo plan includes a limited number of low-priority builds each month ([Expo](https://docs.expo.dev/billing/plans/)), so builds may wait in a queue. Don't waste builds on small changes.
- **Upload the first .aab by hand** in Play Console. After that, you can use `eas submit -p android`, which needs a Google service account key.

### 6.3 Fill in "App content" (all required)
- [ ] **Privacy policy URL** (Section 4.1).
- [ ] **App access:** your app needs sign-in (email code), so reviewers need a way in. Give them a **test account** that works without a real inbox, for example a reviewer email with a fixed code, or a demo mode. This is a common rejection reason.
- [ ] **Ads:** declare "no ads" (if true).
- [ ] **Content rating:** fill in the questionnaire honestly.
- [ ] **Target audience:** choose 18+ (or 13+). Avoid children's categories, which bring extra rules.
- [ ] **Data safety:** declare photos, precise location, email, audio (if uploaded), complaint text. Say whether each is shared, why, and that users can request deletion. Add the deletion web link ([Google](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en-GB)).
- [ ] **Government apps:** answer that Nagrik is **not** a government app and is not affiliated with one.
- [ ] **Foreground service** declaration, only if you keep those permissions.

### 6.4 Store listing
These limits are the usual Play Console ones; **Check** them on the listing page, since Google shows the current limits next to each field.
- [ ] App name (up to 30 characters), for example "Nagrik: Civic Complaints".
- [ ] Short description (up to 80 characters).
- [ ] Full description (up to 4,000 characters), including the "independent, not affiliated with any government" line.
- [ ] App icon: 512 × 512 PNG.
- [ ] Feature graphic: 1024 × 500.
- [ ] At least 2 phone screenshots (use 4–6 showing the real flow).
- [ ] Category: for example "Tools" or "Productivity". **Check** the current category list in Play Console.
- [ ] Contact email.

### 6.5 Testing tracks, then launch
1. **Internal testing:** a quick check with yourself and a few friends.
2. **Closed testing:** new personal accounts must run a closed test with **at least 12 testers opted in for 14 days in a row** before applying for production ([Magora](https://magora-systems.com/google-play-developer-account-cost/)). Invite your pilot users plus friends and family. Ask them to actually open the app during those 14 days.
3. **Apply for production access:** answer Google's questions about the test (what you learned, what you fixed). Review usually takes up to about 7 days, sometimes longer.
4. **Production release:** start with a staged rollout (for example 20% of users), watch crashes and traces, then go to 100%.

### 6.6 Common reasons for rejection
- Reviewers can't sign in (no test account).
- Privacy policy missing, unreachable, or doesn't match the Data safety form.
- No account deletion option, in the app or on the web.
- Permissions requested that the app doesn't clearly need.
- The app looks like an official government app.
- Crashes on the reviewer's device.
- The app sends messages or emails on the user's behalf without clear consent (fixed by Section 3.5).

---

## 7. Option 2: free pilot with a limited distribution account

Use this to run your 5–10 user pilot **before** paying for Play.

### 7.1 What it is
Google's free **limited distribution account** ([Google](https://support.google.com/android-developer-console/answer/16561738?hl=en)):
- No registration fee and no government ID.
- Aimed at **students, hobbyists and small closed groups**. You don't need to be a student; a hobbyist testing their own app fits. **Check** the eligibility questions when you sign up.
- Unlimited apps, but installs on **up to 20 devices**.
- It's for **sharing your app directly (APK)**. It does **not** publish to the Play Store.

### 7.2 Why register at all, if APKs already install?
Google is introducing **developer verification**: apps on certified Android devices will need to come from a registered developer. It started on 30 September 2026 in Indonesia, Singapore and Thailand, and expands globally in **2027** ([Google](https://support.google.com/android-developer-console/answer/16561738?hl=en)). Google's page doesn't mention India yet, so sharing APKs in India should keep working for now. Registering early means your pilot won't break when verification reaches India.

### 7.3 Steps
1. Create the free limited distribution account in the Android Developer Console and register the package name `app.nagrik.civic`.
2. Build an installable APK with your existing preview profile:
   ```bash
   cd mobile
   npx eas-cli build -p android --profile preview
   ```
3. Share the download link from the EAS build page with your testers (WhatsApp works).
4. Testers allow "Install unknown apps" for their browser or WhatsApp once, then install.
5. Run the pilot using `docs/PILOT.md`: 5–10 people, about a week, a reminder on day 3, every complaint recorded in a sheet with its Langfuse trace.
6. For each fix, build a new APK and share it again. Testers install it over the old one.

### 7.4 Moving from Option 2 to Option 1 later
- Keep the **same package name** (`app.nagrik.civic`).
- **Signature problem:** the APK you shared is signed with your EAS key, while the Play Store version is signed by Google's Play App Signing key. Android won't install one over the other, so **testers must uninstall the pilot APK before installing from Play**. Their data is safe on your server, so they just sign in again. Tell them in advance.
- Your pilot testers make a good start on the **12 testers for 14 days** needed for Play's closed test.

---

## 8. After launch: keep it healthy

- [ ] Check Langfuse traces and error reports daily for the first two weeks.
- [ ] Track: complaints filed, % correctly categorised, % correctly routed, % letters usable as-is, % filed automatically vs handed back, crashes, average response time, Gemini cost per complaint.
- [ ] Turn every wrong answer into an eval case (`backend/eval/`), as `docs/PILOT.md` describes.
- [ ] Reply to Play Store reviews.
- [ ] Re-check Google's target API level each year; new deadlines arrive every August.

---

## 9. Costs

| Item | Cost |
|---|---|
| Google Play developer account (Option 1) | **$25 once** |
| Limited distribution account (Option 2) | Free |
| Render (backend) | Free plan; paid only if you need more memory or no sleep |
| Supabase (database, auth, storage) | Free plan |
| Gemini API | Free tier with limits; set a budget cap |
| Expo EAS builds | Free plan, limited low-priority builds each month |
| Firebase (push notifications) | Free |
| Langfuse, Sentry, UptimeRobot, cron-job.org | Free plans |
| Privacy policy hosting (GitHub Pages) | Free |
| Domain name (optional, for email sending via Resend) | Optional, small yearly cost |

**Total to launch on Play: $25.** Everything else can start free.

---

## 10. Suggested timeline

| Week | Work |
|---|---|
| Week 1 | **Human approval before escalation emails (Section 3.5) first.** Then Sections 3 and 4: production backend, external cron, privacy policy, account deletion, permission clean-up, FCM. Create the free limited distribution account. |
| Week 2 | Option 2 pilot with 5–10 users using `docs/PILOT.md`. Fix the top 3 problems. |
| Week 3 | Pay $25, set up Play Console, store listing and App content. Start the closed test with 12+ testers. |
| Weeks 3–5 | 14-day closed test, keep fixing, then apply for production. |
| Week 5–6 | Production release with a staged rollout. Update your resume: "Live on Google Play". |

---

## Sources
- [Google: Understanding Android developer verification (limited distribution account, timelines, fees)](https://support.google.com/android-developer-console/answer/16561738?hl=en)
- [Google: App account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en-GB)
- [Android Developers: Target API level requirements](https://developer.android.com/google/play/requirements/target-sdk)
- [Magora: Google Play developer account cost and closed testing rule (Oct 2026)](https://magora-systems.com/google-play-developer-account-cost/)
- [Expo: Plans and billing](https://docs.expo.dev/billing/plans/)
- Nagrik repository files: `README.md`, `render.yaml`, `backend/Dockerfile`, `backend/.env.example`, `mobile/app.json`, `mobile/eas.json`, `docs/PILOT.md`

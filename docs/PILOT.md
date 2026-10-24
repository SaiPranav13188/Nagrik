# Nagrik pilot: 5–10 real users

The goal is to watch real people file real complaints and fix whatever breaks. The automated tests and the synthetic eval show the agents work on cases we wrote ourselves. Only real users show what we didn't think of.

## Before you invite anyone

- [ ] Backend deployed and `/health` shows `"data":"supabase"` and the AI model you expect.
- [ ] `PORTAL_MODE=sandbox`. Pilot complaints go to the sandbox portal unless you decide otherwise (see "Real filing" below).
- [ ] Langfuse keys set, so every pilot complaint has a trace you can open.
- [ ] Supabase project not paused. Free projects pause after a week of inactivity, and sign-in then fails with "Unable to resolve host".
- [ ] App build installed on your own phone; you have filed one complaint end to end yourself.
- [ ] A WhatsApp group or similar for testers to send screenshots and complaints.

## Who to invite

Aim for a mix. The point is to find different failures, not to get good reviews.

| Tester | Why |
|---|---|
| 2 people who type in Telugu or Hinglish | Language and typo handling |
| 1–2 people over 50, or not comfortable with apps | Sign-in, permissions, confusing screens |
| 1 person with a cheap or old Android phone | Performance, camera, location |
| 1 person outside Wanaparthy | Out-of-area handling: must not be routed to the Wanaparthy office |
| 2–3 others who walk or commute daily | Volume of real issues |

## What to ask each tester

1. Install the app, sign in with email and set up your profile.
2. File **at least 2 complaints** about real problems you see: potholes, lights, garbage, water, drains.
3. Try one complaint using your voice.
4. If you see something someone else already reported, try **Me too**.
5. After filing, open the complaint and tell us whether the department and the letter look right.
6. Send a screenshot of anything confusing, wrong or broken, with one sentence about what you expected.

Give them about a week. Send a reminder on day 3.

## What to record for every complaint

Copy this into a sheet, one row per complaint:

| Field | Where it comes from |
|---|---|
| Tester, date | You |
| Photo shows | Your own look at the photo |
| Category the agent chose / correct? | App or admin console |
| Department chosen / correct? | Admin console |
| Letter usable as-is? (yes / small edits / no) | Tester's opinion + yours |
| Filed automatically, handed back, or stuck? | Complaint status |
| Langfuse trace link | Langfuse (session = complaint id) |
| What broke / what confused the tester | Tester's message |

## Turning pilot data into eval cases

Every wrong category, wrong department or bad letter becomes a new eval case:

1. With the tester's permission, save the photo in `backend/eval/photos/`.
2. Add a row to `backend/eval/labels.csv` with the correct answer.
3. Run `npm run eval:intake` and fix until it passes, without breaking the other cases.

After the pilot, the photo cases are the real accuracy numbers. The synthetic text cases only show that nothing regressed.

## Real filing

The pilot runs in sandbox mode, so nothing reaches a government office. If you want some complaints filed for real:

- Set `PORTAL_MODE=live` only after talking to the testers.
- Every real filing needs the citizen to tap **Submit**. The server never files on a real portal by itself.
- Wanaparthy's portal needs an OTP, so the app hands those complaints to the citizen to finish. This is expected, not a bug.

## After the pilot

- [ ] Fix the top 3 problems by number of testers affected.
- [ ] Add every wrong answer as an eval case.
- [ ] Write a short summary: complaints filed, % categorised correctly, % routed correctly, % letters usable as-is, % automated vs handed back, top 3 issues fixed.

# Google Play submission kit

Everything Play Console asks for, in the order it asks. Copy and paste.

- Privacy policy: https://saipranav13188.github.io/Nagrik/privacy/
- Account deletion: https://saipranav13188.github.io/Nagrik/delete-account/
- Feature graphic (1024×500): `store/feature-graphic.png` (source: `feature-graphic.html`)
- App icon (512×512): export `mobile/assets/icon.png` at 512×512

## Store listing

**App name** (max 30): `Nagrik: Civic Complaints`

**Short description** (max 80):
`Report potholes, garbage and broken lights. Nagrik files and follows up for you.`

**Full description:**

```
Seen a pothole, a broken streetlight, overflowing garbage, a water leak or a blocked drain? Nagrik turns a photo into a proper complaint to the right municipal office, and keeps following up until it is fixed.

HOW IT WORKS
• Take a photo, type a line or just speak, in English, Telugu or Hindi.
• Nagrik works out the problem, finds the office responsible for that location, and writes a clear complaint letter.
• You review it and tap Submit. Nagrik files it on the official grievance portal and gives you the reference number.
• Nagrik checks the status for you. If nothing happens, it prepares an escalation letter to a senior officer, and sends it only after you approve it.

SEE WHAT'S HAPPENING NEARBY
• A map of issues reported around you.
• Tap "Me too" to support a neighbour's complaint instead of filing a duplicate.

PRIVATE BY DESIGN
• Your name and mobile number go only to the office handling your complaint.
• Other users never see who reported an issue.
• Delete your account and all your data from the app at any time.

Currently available for Wanaparthy Municipality, Telangana. More towns coming.

Nagrik is an independent app. It is not affiliated with, endorsed by or acting on behalf of any government body. Complaints are filed on official portals, including the CDMA Telangana grievance portal: https://cdma.telangana.gov.in/Grievance_Redressal
```

Only while the server is in test mode (`PORTAL_MODE=sandbox`), add this line at the top of the full description; the in-app banner follows the server automatically:
`TEST VERSION: complaints go to a practice portal, not to real government offices.`

**App or game:** App. **Category:** Tools.
**Contact email:** your developer email. **Website:** https://saipranav13188.github.io/Nagrik/

**Phone screenshots** (2 to 8, portrait). Take these on the phone (Power + Volume down) using the review account so no real names show:
1. Home screen
2. Report screen with a photo
3. Nearby map
4. A complaint's detail page (reference number + status)

## App content forms

### App access
Choose **All or some functionality is restricted** and add:
- Username: `saipranav1388+playreview@gmail.com`
- Password: the 6-digit code printed by `npx tsx scripts/create-review-account.ts <email>` (run in `backend/`; running it again makes a new code)
- Instructions: `Enter the email, tap "Send code", then type the 6-digit password above into the code box. This test account only files to a practice portal.`

### Ads
No, the app does not contain ads.

### Content rating (IARC questionnaire)
Category: **Utility, productivity, communication or other**. Answer **No** to violence, sexuality, language, controlled substances, gambling. "Users can interact or exchange content": **Yes** (reported issues with photos are visible to nearby users). "Shares user location with other users": **Yes** (the location of reported issues is shown on the Nearby map, not the user's live location). Expected rating: Everyone / 3+ with "Users interact".

### Target audience
**18 and over** only. Not designed for children.

### Government apps
"Is your app a government app?" **No**. The listing already says it is independent and links the official source.

### Data safety

General: data is encrypted in transit: **Yes**. Users can request deletion: **Yes** (link above). Data collected is not sold. No data is used for ads.

| Data type | Collected | Shared* | Optional? | Purpose |
|---|---|---|---|---|
| Personal info → Name | Yes | Yes (government office) | Required to file | App functionality |
| Personal info → Email address | Yes | Yes (government office) | Required | App functionality, Account management |
| Personal info → Phone number | Yes | Yes (government office) | Required to file | App functionality |
| Location → Precise location | Yes | Yes (office; shown with the issue on Nearby) | Optional (can type an address) | App functionality |
| Photos and videos → Photos | Yes | Yes (office; shown on Nearby). Profile photo: not shared | Optional | App functionality |
| Audio → Voice or sound recordings | Yes, processed ephemerally | No | Optional | App functionality |
| App activity → Other user-generated content (complaint text) | Yes | Yes (office; shown on Nearby) | Required | App functionality |
| App activity → Other user-generated content (help questions, 👍/👎) | Yes | No | Optional | App functionality, Analytics (fixing wrong help answers) |
| Device or other IDs (push token) | Yes | No | Optional | App functionality (notifications) |

*"Shared" in Google's sense means sent to a third party that is not your service provider. Supabase, Gemini, Render, Langfuse, Resend, Expo and Firebase are service providers, so they are not "sharing".

## Testing before production (new personal accounts)

Google requires a **closed test with at least 12 testers for 14 days in a row** before you can apply for production.
1. Play Console → Testing → Closed testing → Create track.
2. Upload the `.aab` from `npx eas-cli build -p android --profile production` (in `mobile/`).
3. Add testers' Gmail addresses (your pilot group from `docs/PILOT.md`) and share the opt-in link.
4. After 14 days with 12+ opted-in testers, apply for production access from the Dashboard.

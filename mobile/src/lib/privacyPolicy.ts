/**
 * The privacy policy shown inside the app (Profile → Your privacy). Keep it word for word in sync
 * with docs/privacy/index.html, which is the public copy Google Play links to.
 */
export const PRIVACY_UPDATED = '27 October 2026';

export type PolicyBlock =
  | { kind: 'p'; text: string }
  | { kind: 'table'; rows: [string, string][] }
  | { kind: 'list'; items: string[] };

export const PRIVACY_INTRO =
  'Nagrik ("we", "the app") helps you report civic problems to the municipal office responsible for them. This policy explains what we collect, why, who it is shared with, and how to delete it. Nagrik is an independent app and is not affiliated with any government body.';

export const PRIVACY_SECTIONS: { title: string; blocks: PolicyBlock[] }[] = [
  {
    title: 'What we collect',
    blocks: [
      {
        kind: 'table',
        rows: [
          ['Email address', 'To sign you in with a one-time code.'],
          ['Name and mobile number', 'Government grievance portals require them to register a complaint. Entered by you in your profile.'],
          ['Profile photo (optional)', 'Shown in your own profile. It is not shown to other users or sent to government offices.'],
          ['Precise location (only while you use the app)', 'To find the office responsible for the place you report, and to show issues reported near you. We never collect location in the background.'],
          ['Photos you take or choose', "Attached to your complaint as evidence. If you choose a photo from your gallery, the app reads the location saved in that photo (if any) on your phone, only to fill in where the problem is."],
          ['Voice recordings (optional)', 'If you describe a problem by voice, the recording is turned into text. We do not keep the recording after that.'],
          ['Complaint text, status and history', 'To file the complaint, track it, and remind or escalate when it is not resolved.'],
          ['Help questions (optional)', 'If you use Help & support, your questions are used to answer them, and your 👍/👎 ratings help us correct wrong answers.'],
          ['Push notification token', "To tell you when a complaint's status changes."],
          ['Basic technical logs', 'Errors and request logs on our server, used to fix problems.'],
        ],
      },
      { kind: 'p', text: 'We do not collect contacts, call logs, SMS, files, advertising IDs or background location. We do not show ads and we do not sell your data.' },
    ],
  },
  {
    title: 'Who we share it with',
    blocks: [
      {
        kind: 'list',
        items: [
          "The government office handling your complaint. When you file a complaint, your name, mobile number, email, complaint text, photo and location are sent to that office's grievance portal. If a complaint is not resolved, an escalation letter with the same details goes to a senior office, but only after you approve it in the app or send it yourself.",
          'Other Nagrik users nearby. The "Nearby" screen shows reported issues (photo, description, location, status and department) so neighbours can support them. Your name, mobile number, email and profile photo are never shown to other users.',
          'Service providers that run the app for us: Supabase (sign-in, database and photo storage; photos are stored at unguessable web links), Google Gemini (reads your photo, text, voice or help question to understand it and write the complaint or answer), Render (hosts our server), Langfuse (records how the app\'s AI steps ran, so we can find and fix mistakes), Resend (sends escalation emails you approve), Expo and Google Firebase Cloud Messaging (deliver push notifications), and OpenStreetMap or Esri (map images; your device requests map tiles directly from them). These providers may process data on servers outside India. They may use it only to provide their service to us.',
          'When the law requires it, for example a valid legal order.',
        ],
      },
    ],
  },
  {
    title: 'How long we keep it',
    blocks: [
      { kind: 'p', text: 'We keep your account and complaints until you delete them. When you delete your account, we delete your profile (including your profile photo), complaints, photos, notifications, "Me too" supports, AI traces and your sign-in account straight away.' },
      { kind: 'p', text: "Complaints already filed with a government office stay in that office's own system, and escalation emails already sent stay with their recipients. We cannot delete those; please contact the office directly." },
    ],
  },
  {
    title: 'Your choices and rights',
    blocks: [
      {
        kind: 'list',
        items: [
          'See and edit your name, mobile number and profile photo in the app under Profile.',
          "Turn off location, camera, microphone or notifications at any time in your phone's settings. Some features will not work without them.",
          'Delete your account and data: in the app go to Profile → Delete account.',
          'Ask us for a copy of your data or to correct it by emailing us.',
        ],
      },
    ],
  },
  {
    title: 'Security',
    blocks: [{ kind: 'p', text: "Data is sent over encrypted connections (HTTPS). Access to our database is limited to the app's server. No system is perfectly secure, but we take reasonable steps to protect your data." }],
  },
  {
    title: 'Children',
    blocks: [{ kind: 'p', text: 'Nagrik is meant for adults. We do not knowingly collect data from children under 18.' }],
  },
  {
    title: 'Changes and contact',
    blocks: [{ kind: 'p', text: 'If we change this policy, we will update the date at the top and tell you in the app when the change is significant. Questions or requests: tap "Email support" below.' }],
  },
];

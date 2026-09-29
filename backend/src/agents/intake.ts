import { generateText, Output, tool } from 'ai';
import { z } from 'zod';
import { config } from '../config.js';
import { repo } from '../db/index.js';
import { ISSUE_TYPES, type IssueType } from '../db/types.js';
import { reverseGeocode } from '../services/geocode.js';
import { loadPhoto } from '../services/storage.js';
import { findNearby } from '../services/nearby.js';
import { noteGeminiError, visionModel, type AgentDefinition } from '../ai/runtime.js';

export interface IntakeInput {
  /** Pre-allocated complaint id so every intake tool call is logged against it (also across a clarification round-trip). */
  intakeId: string;
  userId: string;
  photoUrl: string;
  latitude: number | null;
  longitude: number | null;
  manualAddress: string | null;
  userNote: string | null;
  clarificationAnswer: IssueType | null;
  autoSubmit: boolean;
  /** The citizen saw a possible duplicate and chose to file a separate complaint anyway. */
  forceNew: boolean;
}

/** Same issue type within this distance counts as a likely duplicate. */
export const DUPLICATE_RADIUS_M = 60;

export const ISSUE_LABELS: Record<IssueType, string> = {
  pothole: 'Pothole / damaged road',
  streetlight: 'Street light not working',
  garbage: 'Garbage / waste dumping',
  water_leakage: 'Water leakage / pipeline burst',
  drainage: 'Blocked drain / sewage overflow',
  other: 'Something else',
};

const photoAnalysisSchema = z.object({
  is_civic_issue: z.boolean().describe('False for selfies, indoor/private property, screenshots, or unclear images.'),
  issue_type: z.enum(ISSUE_TYPES),
  confidence: z.number().min(0).max(1),
  alternative_issue_type: z.enum(ISSUE_TYPES).nullable().describe('Second plausible category if the photo is ambiguous.'),
  alternative_confidence: z.number().min(0).max(1).nullable(),
  severity: z.enum(['low', 'medium', 'high']).describe('high = immediate safety risk (open manhole, live wire, large crater on a main road).'),
  description: z.string().describe('2-4 sentences, factual, formal, third person. Only what is visible. No speculation about cause.'),
  visible_details: z.array(z.string()).describe('Concrete observations: size estimates, landmarks, signage, time of day.'),
  rejection_reason: z.string().nullable(),
});

const KEYWORDS: Array<[IssueType, RegExp]> = [
  ['pothole', /pothole|crater|road (is )?(damaged|broken)|gunta|గుంత|गड्ढा/i],
  ['streetlight', /street ?light|lamp|pole|light not working|dark|వీధి దీపం|स्ट्रीट ?लाइट/i],
  ['garbage', /garbage|trash|waste|dump|rubbish|చెత్త|कचरा/i],
  ['water_leakage', /leak|pipe|burst|water (wast|flow)|tap|నీరు|पानी|पाइप/i],
  ['drainage', /drain|sewage|manhole|gutter|overflow|మురుగు|नाली|सीवर/i],
];

function keywordGuess(text: string): IssueType | null {
  for (const [t, re] of KEYWORDS) if (re.test(text)) return t;
  return null;
}

export const intakeAgent: AgentDefinition<IntakeInput> = {
  name: 'intake_agent',
  maxSteps: 8,
  stopOnTools: ['save_complaint', 'ask_user_clarification', 'reject_photo', 'suggest_join_existing'],
  system: `You are the Intake Agent of Nagrik, a civic complaint service in India.
Your job: turn a citizen's photo into one structured, accurate civic issue record.

Procedure:
1. Call analyze_photo exactly once.
2. If coordinates exist, call reverse_geocode to get the address. If geocoding fails, use the citizen's typed address.
3. Decide:
   - If the photo is not a public civic issue → call reject_photo with a short, polite reason.
   - If the photo is ambiguous (confidence < 0.6, OR an alternative type has confidence within 0.2 of the top type) AND the citizen has not already answered a clarification → call ask_user_clarification with ONE short question and 2-6 options. Never guess: a wrong category routes the complaint to the wrong department.
   - Otherwise, once the issue type is settled: if coordinates exist and the citizen has NOT chosen to file separately, call find_nearby_duplicates for that issue type.
     If it returns an open complaint that is very likely the same physical problem (same type, within ~60 m, description compatible) → call suggest_join_existing with it. One well-supported complaint is far stronger than many duplicates.
   - Otherwise → call save_complaint. If the citizen answered a clarification, their answer wins.
Keep descriptions factual and formal; never invent details not visible in the photo or given by the citizen.`,

  buildPrompt(input) {
    return [
      `New civic issue report.`,
      `Photo: attached via analyze_photo tool.`,
      `Coordinates: ${input.latitude != null ? `${input.latitude}, ${input.longitude}` : 'not available'}`,
      `Citizen-typed address: ${input.manualAddress || 'none'}`,
      `Citizen note: ${input.userNote || 'none'}`,
      `Clarification answer from citizen: ${input.clarificationAnswer ? `${input.clarificationAnswer} (${ISSUE_LABELS[input.clarificationAnswer]})` : 'not asked yet'}`,
      `Citizen chose to file separately despite nearby reports: ${input.forceNew ? 'yes' : 'no'}`,
    ].join('\n');
  },

  buildTools(ctx, input) {
    return {
      analyze_photo: tool({
        description: 'Gemini vision analysis of the citizen photo: classifies the civic issue and writes a factual description.',
        inputSchema: z.object({ focus_hint: z.string().optional().describe('Optional hint, e.g. the citizen note.') }),
        execute: async ({ focus_hint }) => {
          const model = visionModel();
          const offlineAnalysis = () => {
            // No vision available: use the citizen's own words if they gave any; else be honest.
            const guess = keywordGuess(`${input.userNote ?? ''} ${focus_hint ?? ''}`);
            return {
              is_civic_issue: true,
              issue_type: guess ?? 'other',
              confidence: guess ? 0.7 : 0.2,
              alternative_issue_type: null,
              alternative_confidence: null,
              severity: 'medium',
              description: guess
                ? `A ${ISSUE_LABELS[guess].toLowerCase()} issue has been reported by a resident at the location below.${input.userNote ? ` Resident's note: "${input.userNote}".` : ''} Photographic evidence is attached.`
                : 'A civic issue has been reported by a resident at the location below. Photographic evidence is attached.',
              visible_details: [],
              rejection_reason: null,
              mode: 'offline_no_vision',
            };
          };
          if (!model) return offlineAnalysis();
          try {
          const photo = await loadPhoto(input.photoUrl);
          const { output } = await generateText({
            model,
            output: Output.object({ schema: photoAnalysisSchema }),
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: `Classify this photo for a municipal complaint in India. Categories: ${ISSUE_TYPES.join(', ')}.
- pothole: damaged/cratered road surface
- streetlight: non-working/damaged street light or pole
- garbage: dumped waste, overflowing bins, uncollected garbage
- water_leakage: burst/leaking water pipe, public tap wasting water
- drainage: blocked/overflowing drains, open manholes, sewage on road
- other: any other public civic issue (encroachment, stray cattle, broken footpath…)
Be calibrated: if water on a road could be either a pipe leak or drain overflow, say so via alternative_issue_type.
Citizen note: ${input.userNote || 'none'}. ${focus_hint ? `Hint: ${focus_hint}` : ''}`,
                  },
                  { type: 'image', image: photo.data, mediaType: photo.mimeType },
                ],
              },
            ],
            maxRetries: 1,
          });
          return output;
          } catch (e) {
            noteGeminiError(e, config.geminiVisionModel);
            return offlineAnalysis();
          }
        },
      }),

      reverse_geocode: tool({
        description: 'Reverse geocode coordinates to a postal address using OpenStreetMap Nominatim.',
        inputSchema: z.object({ lat: z.number(), lng: z.number() }),
        execute: async ({ lat, lng }) => reverseGeocode(lat, lng),
      }),

      ask_user_clarification: tool({
        description: 'Ask the citizen ONE clarifying question when the issue type is ambiguous. Ends this run; the app shows the options.',
        inputSchema: z.object({
          question: z.string(),
          options: z.array(z.object({ issue_type: z.enum(ISSUE_TYPES), label: z.string() })).min(2).max(6),
        }),
        execute: async (q) => ({ asked: true, ...q }),
      }),

      find_nearby_duplicates: tool({
        description: `Open complaints of the same issue type reported within ${DUPLICATE_RADIUS_M} m of this location, nearest first.`,
        inputSchema: z.object({ issue_type: z.enum(ISSUE_TYPES) }),
        execute: async ({ issue_type }) => {
          if (input.latitude == null || input.longitude == null) return { candidates: [], note: 'No coordinates.' };
          const hits = await findNearby(input.latitude, input.longitude, DUPLICATE_RADIUS_M, { issueType: issue_type, openOnly: true, limit: 3 });
          return {
            candidates: hits.map(({ c, distance }) => ({
              complaint_id: c.id,
              distance_m: Math.round(distance),
              status: c.status,
              description: c.description,
              supporters: c.supporters_count ?? 0,
              reported_by_this_citizen: c.user_id === input.userId,
              reported_days_ago: Math.floor((Date.now() - new Date(c.created_at).getTime()) / 86_400_000),
            })),
          };
        },
      }),

      suggest_join_existing: tool({
        description: 'Offer the citizen to add their support ("Me too") to an existing nearby complaint instead of filing a duplicate. Ends this run; the citizen decides.',
        inputSchema: z.object({ complaint_id: z.string(), reason: z.string().describe('One short sentence, e.g. "A pothole 20 m away was reported 3 days ago."') }),
        execute: async ({ complaint_id, reason }) => {
          const c = await repo.getComplaint(complaint_id);
          if (!c) return { error: 'Unknown complaint_id — use one from find_nearby_duplicates.' };
          return { suggested: true, complaint_id, reason };
        },
      }),

      reject_photo: tool({
        description: 'Reject the photo when it does not show a public civic issue. Ends this run.',
        inputSchema: z.object({ reason: z.string() }),
        execute: async ({ reason }) => ({ rejected: true, reason }),
      }),

      save_complaint: tool({
        description: 'Create the complaint record. Ends intake; routing, drafting and submission continue automatically.',
        inputSchema: z.object({
          issue_type: z.enum(ISSUE_TYPES),
          description: z.string().min(20),
          severity: z.enum(['low', 'medium', 'high']),
          address: z.string(),
          city: z.string().nullable(),
          state: z.string().nullable(),
          pincode: z.string().nullable(),
        }),
        execute: async (a) => {
          const c = await repo.createComplaint({
            id: input.intakeId,
            user_id: input.userId,
            photo_url: input.photoUrl,
            issue_type: a.issue_type,
            description: a.description,
            severity: a.severity,
            user_note: input.userNote,
            latitude: input.latitude,
            longitude: input.longitude,
            address: a.address,
            city: a.city,
            state: a.state,
            pincode: a.pincode,
            status: 'analyzing',
            auto_submit: input.autoSubmit,
          });
          ctx.setComplaintId(c.id);
          return { saved: true, complaint_id: c.id };
        },
      }),
    };
  },

  offlinePolicy(s) {
    const a = s.last('analyze_photo')?.output;
    if (!a) return { tool: 'analyze_photo', input: {} };
    const hasCoords = /Coordinates: -?\d/.test(s.userText);
    if (hasCoords && !s.called('reverse_geocode')) {
      const m = s.userText.match(/Coordinates: (-?[\d.]+), (-?[\d.]+)/)!;
      return { tool: 'reverse_geocode', input: { lat: Number(m[1]), lng: Number(m[2]) } };
    }
    if (a.is_civic_issue === false) return { tool: 'reject_photo', input: { reason: a.rejection_reason || 'This photo does not appear to show a public civic issue.' } };

    const answered = s.userText.match(/Clarification answer from citizen: (\w+) \(/)?.[1] as IssueType | undefined;
    const ambiguous = a.confidence < 0.6 || (a.alternative_confidence != null && a.confidence - a.alternative_confidence < 0.2);
    if (ambiguous && !answered) {
      return {
        tool: 'ask_user_clarification',
        input: {
          question: 'What best describes the problem in your photo?',
          options: (['pothole', 'garbage', 'streetlight', 'water_leakage', 'drainage', 'other'] as IssueType[]).map((t) => ({ issue_type: t, label: ISSUE_LABELS[t] })),
        },
      };
    }
    const forceNew = /file separately despite nearby reports: yes/.test(s.userText);
    const settled = answered ?? a.issue_type;
    if (hasCoords && !forceNew && !s.called('find_nearby_duplicates')) {
      return { tool: 'find_nearby_duplicates', input: { issue_type: settled } };
    }
    const dup = s.last('find_nearby_duplicates')?.output?.candidates?.[0];
    if (dup && !forceNew && !s.called('suggest_join_existing')) {
      return {
        tool: 'suggest_join_existing',
        input: {
          complaint_id: dup.complaint_id,
          reason: (() => {
            const where = dup.distance_m < 15 ? 'right here' : `${dup.distance_m} m away`;
            const when = dup.reported_days_ago ? `${dup.reported_days_ago} day(s) ago` : 'today';
            return dup.reported_by_this_citizen ? `You already reported this ${where} ${when}.` : `The same problem was reported ${where} ${when}.`;
          })(),
        },
      };
    }
    const geo = s.last('reverse_geocode')?.output;
    const typed = s.userText.match(/Citizen-typed address: (.*)/)?.[1];
    const issue = answered ?? a.issue_type;
    const description =
      answered && answered !== a.issue_type
        ? `A ${ISSUE_LABELS[answered].toLowerCase()} issue has been reported by a resident at the location below.${/Citizen note: (?!none)(.*)/.test(s.userText) ? ` Resident's note: "${s.userText.match(/Citizen note: (.*)/)![1]}".` : ''} Photographic evidence is attached.`
        : a.description;
    return {
      tool: 'save_complaint',
      input: {
        issue_type: issue,
        description,
        severity: a.severity ?? 'medium',
        address: geo?.address ?? (typed && typed !== 'none' ? typed : 'Location not provided'),
        city: geo?.city ?? null,
        state: geo?.state ?? null,
        pincode: geo?.pincode ?? null,
      },
    };
  },
};

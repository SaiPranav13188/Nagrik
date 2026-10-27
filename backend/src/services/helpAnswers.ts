import { config } from '../config.js';

/**
 * Fixed, human-approved help answers. These are what the help assistant says for the common
 * questions — word for word, never generated — so they are always correct. Button names must match
 * the app's labels (mobile/src/lib/i18n.tsx) in each language. Edit here and redeploy the backend;
 * no new APK is needed.
 */
export type HelpLang = 'en' | 'te' | 'hi';
type Answer = Record<HelpLang, string>;

export interface HelpTopic {
  id: string;
  /** One line for the AI classifier: when this topic is the right answer. */
  about: string;
  answer: () => Answer;
  /** High-precision keyword matches (lower-cased text). Anything unmatched goes to the classifier. */
  patterns: RegExp[];
}

const checkDays = () => Math.max(1, Math.round(config.recheckIntervalHours / 24));
const escDays = () => config.escalationThresholdDays;

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'emergency',
    about: 'danger right now: live/fallen electric wire, shock, fire, accident, injury, collapse, flooding into homes',
    patterns: [/\b(live|fallen|hanging|broken) (electric |electricity |power )?wires?\b/, /\belectric(al)? shock\b/, /\b(fire|accident|injur(y|ed)|emergency|collapsed?)\b/, /కరెంట్ షాక్|ప్రమాదం|అగ్ని|अत्यावश्यक|आग|दुर्घटना|करंट/],
    answer: () => ({
      en: 'If anyone is in danger — a live wire, fire, accident or injury — call 112 right away. Nagrik is not an emergency service. Once everyone is safe, you can still report the problem in the app so it gets fixed.',
      te: 'ఎవరికైనా ప్రమాదం ఉంటే — కరెంట్ తీగ, అగ్ని, ప్రమాదం లేదా గాయం — వెంటనే 112కు కాల్ చేయండి. నాగరిక్ అత్యవసర సేవ కాదు. అందరూ సురక్షితంగా ఉన్నాక, సమస్య పరిష్కారం కోసం యాప్‌లో నివేదించవచ్చు.',
      hi: 'अगर किसी की जान को खतरा है — बिजली का तार, आग, दुर्घटना या चोट — तुरंत 112 पर कॉल करें। नागरिक आपातकालीन सेवा नहीं है। सब सुरक्षित होने के बाद आप ऐप में समस्या दर्ज कर सकते हैं ताकि वह ठीक हो।',
    }),
  },
  {
    id: 'how_to_report',
    about: 'how to report / file / register a new complaint, the photo (one per complaint), how the app files it',
    patterns: [/\bhow (do i|to|can i|should i) (report|file|register|make|raise|submit|lodge|send)\b/, /\b(new|first) complaint\b/, /\bhow (does|do) (nagrik|the app|this app|it) work\b/, /ఎలా (నివేదించ|ఫిర్యాదు చేయ)|फ़?शिकायत कैसे (करें|दर्ज)|कैसे (रिपोर्ट|शिकायत)/],
    answer: () => ({
      en: "Tap 'Report an issue' on Home (or the Report tab). Take a photo or choose one from the gallery, let the app use your location (or tap 'Enter address manually'), add details if you like — you can also speak them — and tap 'Analyze & file'. The app finds the right department and writes the complaint for you. Each complaint has one photo — choose the one that shows the problem most clearly.",
      te: "హోమ్‌లో 'సమస్యను నివేదించండి' (లేదా 'నివేదించు' ట్యాబ్) నొక్కండి. ఫోటో తీయండి లేదా గ్యాలరీ నుండి ఎంచుకోండి, మీ లొకేషన్ వాడనివ్వండి (లేదా 'చిరునామా టైప్ చేయండి' నొక్కండి), కావాలంటే వివరాలు రాయండి లేదా మాట్లాడండి. యాప్ సరైన శాఖను కనుగొని, ఫిర్యాదు మీ కోసం రాస్తుంది. ప్రతి ఫిర్యాదుకు ఒక ఫోటో మాత్రమే — సమస్య స్పష్టంగా కనిపించేదాన్ని ఎంచుకోండి.",
      hi: "होम पर 'समस्या बताएँ' (या 'रिपोर्ट' टैब) दबाएँ। फ़ोटो लें या गैलरी से चुनें, ऐप को आपकी लोकेशन लेने दें (या 'पता खुद लिखें' दबाएँ), चाहें तो विवरण लिखें या बोलें। ऐप सही विभाग ढूँढकर आपके लिए शिकायत लिखता है। हर शिकायत में एक ही फ़ोटो होती है — वह चुनें जिसमें समस्या सबसे साफ़ दिखे।",
    }),
  },
  {
    id: 'action_needed',
    about: 'status "Action needed" / complaint could not be filed automatically / CAPTCHA or OTP on the government portal / how to finish filing manually',
    patterns: [/\baction needed\b/, /\b(could ?n.?t|can ?not|did ?n.?t|not|failed to) (be )?(file|filed|submit|submitted)\b/, /\bsubmission failed\b/, /\bcaptcha\b/, /\bfinish filing\b/, /మీ చర్య అవసరం|आपकी ज़रूरत/],
    answer: () => ({
      en: "'Action needed' means the app couldn't file the complaint on the portal by itself — for example the portal asked for a CAPTCHA or OTP, or the office has no online form. The exact reason is shown on the complaint. Open it and follow 'Finish filing in 3 quick steps': tap 'Copy', tap 'Open portal' and paste it there, then tap 'I've submitted it' (you can add the reference number). Or tap 'Retry automatic filing'. If it says 'Add name & mobile', add those first.",
      te: "'మీ చర్య అవసరం' అంటే యాప్ పోర్టల్‌లో ఫిర్యాదును స్వయంగా నమోదు చేయలేకపోయింది — ఉదాహరణకు పోర్టల్ CAPTCHA లేదా OTP అడిగింది, లేదా ఆ కార్యాలయానికి ఆన్‌లైన్ ఫారం లేదు. కారణం ఫిర్యాదులో కనిపిస్తుంది. దాన్ని తెరిచి '3 సులభ దశల్లో పూర్తి చేయండి' పాటించండి: 'కాపీ' నొక్కండి, 'పోర్టల్ తెరవండి' నొక్కి అక్కడ పేస్ట్ చేయండి, తర్వాత 'నేను సమర్పించాను' నొక్కండి (రిఫరెన్స్ నంబర్ కూడా ఇవ్వవచ్చు). లేదా 'మళ్ళీ ఆటోమేటిక్‌గా ప్రయత్నించండి' నొక్కండి. 'పేరు & మొబైల్ జోడించండి' కనిపిస్తే, ముందు అవి జోడించండి.",
      hi: "'आपकी ज़रूरत' का मतलब है ऐप पोर्टल पर शिकायत खुद दर्ज नहीं कर पाया — जैसे पोर्टल ने CAPTCHA या OTP माँगा, या दफ़्तर का ऑनलाइन फ़ॉर्म नहीं है। सही कारण शिकायत पर दिखता है। उसे खोलें और '3 आसान चरणों में पूरा करें' अपनाएँ: 'कॉपी' दबाएँ, 'पोर्टल खोलें' दबाकर वहाँ पेस्ट करें, फिर 'मैंने सबमिट कर दी' दबाएँ (रेफ़रेंस नंबर भी डाल सकते हैं)। या 'फिर से अपने-आप दर्ज करें' दबाएँ। अगर 'नाम और मोबाइल जोड़ें' दिखे, तो पहले वह जोड़ें।",
    }),
  },
  {
    id: 'auto_submit',
    about: 'the "File automatically" setting, the review window, Hold, Ready to file, Submit now',
    patterns: [/\b(auto.?submit|file automatically|automatic(ally)? fil|review window)\b/, /\bready to file\b/, /\bsubmit now\b/, /\bhold\b.*\b(button|mean|do)\b/, /ఆటోమేటిక్‌గా నమోదు|अपने-आप दर्ज/],
    answer: () => ({
      en: "'File automatically' is in Profile → Preferences. When it's on, a new complaint is filed by itself after a short review window — tap 'Hold' during that time if you want to check or change it first. When it's off, the complaint waits as 'Ready to file' until you open it and tap 'Submit now'.",
      te: "'ఆటోమేటిక్‌గా నమోదు' సెట్టింగ్ ప్రొఫైల్ → ప్రాధాన్యతలలో ఉంది. ఆన్‌లో ఉంటే, కొత్త ఫిర్యాదు చిన్న సమీక్ష సమయం తర్వాత దానంతట అదే నమోదవుతుంది — ముందు చూడాలంటే లేదా మార్చాలంటే ఆ సమయంలో 'ఆపండి' నొక్కండి. ఆఫ్‌లో ఉంటే, మీరు తెరిచి 'పంపండి' నొక్కే వరకు ఫిర్యాదు 'నమోదుకు సిద్ధం'గా ఉంటుంది.",
      hi: "'अपने-आप दर्ज करें' सेटिंग प्रोफ़ाइल → पसंद में है। चालू होने पर नई शिकायत थोड़े समीक्षा समय के बाद खुद दर्ज हो जाती है — पहले देखना या बदलना हो तो उस दौरान 'रोकें' दबाएँ। बंद होने पर शिकायत 'दर्ज करने को तैयार' रहती है, जब तक आप उसे खोलकर 'अभी भेजें' न दबाएँ।",
    }),
  },
  {
    id: 'edit_complaint',
    about: 'change / edit / correct the complaint letter text or subject before it is filed',
    patterns: [/\b(edit|change|correct|modify|rewrite|update) (the |my )?(complaint|letter|text|subject|draft)\b/, /ఫిర్యాదు మార్చ|शिकायत (बदल|एडिट)/],
    answer: () => ({
      en: "Before it's filed, open the complaint and tap 'Edit complaint' to change the subject or text — or 'Rewrite with AI'. If it's about to be filed automatically, tap 'Hold' first. After a complaint is filed, its text can't be changed because it is already with the office.",
      te: "నమోదు కాకముందు, ఫిర్యాదును తెరిచి 'ఫిర్యాదు మార్చండి' నొక్కి విషయం లేదా వివరాలు మార్చవచ్చు. ఆటోమేటిక్‌గా నమోదు కాబోతుంటే, ముందు 'ఆపండి' నొక్కండి. నమోదైన తర్వాత ఫిర్యాదు కార్యాలయానికి చేరింది కాబట్టి దాన్ని మార్చలేరు.",
      hi: "दर्ज होने से पहले शिकायत खोलें और विषय या टेक्स्ट बदलने के लिए 'शिकायत बदलें' दबाएँ। अगर वह अपने-आप दर्ज होने वाली है, तो पहले 'रोकें' दबाएँ। दर्ज होने के बाद शिकायत दफ़्तर पहुँच चुकी होती है, इसलिए उसे बदला नहीं जा सकता।",
    }),
  },
  {
    id: 'withdraw_complaint',
    about: 'delete / withdraw / cancel / remove a complaint (not the whole account)',
    patterns: [/\b(delete|withdraw|cancel|remove)\b.{0,20}\bcomplaints?\b/, /\bcomplaints?\b.{0,20}\b(delete|withdraw|cancel|remove)\b/, /ఫిర్యాదు (ఉపసంహరించ|తొలగించ|రద్దు)|शिकायत (वापस|हटा|डिलीट|रद्द)/],
    answer: () => ({
      en: "You can withdraw a complaint only before it is filed: open it and tap 'Withdraw complaint'. Once a complaint has been filed with an office it can't be deleted. If the problem has been fixed, tap 'Yes, fixed' under 'Is it fixed?' instead.",
      te: "నమోదు కాకముందు మాత్రమే ఫిర్యాదును ఉపసంహరించవచ్చు: దాన్ని తెరిచి 'ఫిర్యాదు ఉపసంహరించండి' నొక్కండి. కార్యాలయంలో నమోదైన ఫిర్యాదును తొలగించలేరు. సమస్య పరిష్కారమైతే, 'పరిష్కారమైందా?' కింద 'అవును' నొక్కండి.",
      hi: "शिकायत सिर्फ़ दर्ज होने से पहले वापस ली जा सकती है: उसे खोलें और 'शिकायत वापस लें' दबाएँ। दफ़्तर में दर्ज हो चुकी शिकायत हटाई नहीं जा सकती। अगर समस्या ठीक हो गई है, तो 'क्या ठीक हो गया?' के नीचे 'हाँ, ठीक हुआ' दबाएँ।",
    }),
  },
  {
    id: 'status_checks',
    about: 'how/when the app checks the complaint status, "Next automatic check", "Check status now", "Checked just now", status history',
    patterns: [/\bcheck status\b/, /\bnext (automatic )?check\b/, /\bchecked just now\b/, /\bstatus history\b/, /\bhow often\b.*\bcheck/, /\bwhen (will|do) (you|the app|nagrik) check\b/, /స్థితి చూడ|ఎప్పుడు చెక్|स्थिति देख|कब (चेक|जाँच)/],
    answer: () => ({
      en: `After filing, Nagrik checks the office's portal for updates automatically every ${checkDays()} days — the complaint shows 'Next automatic check in …'. Tap 'Check status now' to check right away; if it was checked in the last few minutes you'll just see 'Status is up to date'. Every check is listed under 'Status history'.`,
      te: `నమోదైన తర్వాత, నాగరిక్ ప్రతి ${checkDays()} రోజులకు ఒకసారి కార్యాలయ పోర్టల్‌లో స్థితిని ఆటోమేటిక్‌గా చూస్తుంది — తదుపరి చెక్ ఎప్పుడో ఫిర్యాదులో కనిపిస్తుంది. వెంటనే చూడాలంటే 'ఇప్పుడే స్థితి చూడండి' నొక్కండి; కొన్ని నిమిషాల ముందే చూసి ఉంటే 'స్థితి తాజాగా ఉంది' అని వస్తుంది. ప్రతి చెక్ 'స్థితి చరిత్ర'లో ఉంటుంది.`,
      hi: `दर्ज होने के बाद नागरिक हर ${checkDays()} दिन में दफ़्तर के पोर्टल पर स्थिति अपने-आप देखता है — अगली जाँच कब है, यह शिकायत पर दिखता है। तुरंत देखने के लिए 'अभी स्थिति देखें' दबाएँ; अगर कुछ मिनट पहले ही देखा गया था तो 'स्थिति अपडेट है' दिखेगा। हर जाँच 'स्थिति इतिहास' में दर्ज होती है।`,
    }),
  },
  {
    id: 'escalation',
    about: 'escalation: senior officer letter/email, when it happens, approving/sending/cancelling it, "Escalation letter ready to send"',
    patterns: [/\bescalat/, /\bsenior officer\b/, /\bhigher (official|authority|officer)\b/, /ఎస్కలేష|ఎస్కలేట్|पै?एस्केले|आगे बढ़ाई/],
    answer: () => ({
      en: `If the office doesn't act within about ${escDays()} days of filing, Nagrik writes an escalation email to a senior officer. Nothing is sent without you: open the complaint, read it under 'Review your escalation email', tap 'Edit' to change it if you like, then 'Send email' — or tap 'Don't send'. If the office can't be emailed automatically you'll see 'Escalation letter ready to send': tap 'Copy' and send it yourself. Escalation starts automatically; there is no button to start it early.`,
      te: `నమోదైన సుమారు ${escDays()} రోజుల్లో కార్యాలయం స్పందించకపోతే, నాగరిక్ ఉన్నతాధికారికి ఎస్కలేషన్ ఇమెయిల్ రాస్తుంది. మీ అనుమతి లేకుండా ఏదీ పంపదు: ఫిర్యాదును తెరిచి 'ఎస్కలేషన్ ఇమెయిల్ చూడండి' కింద చదవండి, కావాలంటే మార్చండి, తర్వాత 'ఇమెయిల్ పంపండి' — లేదా 'పంపవద్దు' నొక్కండి. ఆటోమేటిక్‌గా ఇమెయిల్ చేయలేని కార్యాలయమైతే 'ఎస్కలేషన్ లేఖ సిద్ధం' కనిపిస్తుంది: 'కాపీ' నొక్కి మీరే పంపండి. ఎస్కలేషన్ ఆటోమేటిక్‌గా మొదలవుతుంది; ముందే మొదలుపెట్టే బటన్ లేదు.`,
      hi: `अगर दर्ज होने के लगभग ${escDays()} दिन में दफ़्तर कुछ नहीं करता, तो नागरिक वरिष्ठ अधिकारी को एस्केलेशन ईमेल लिखता है। आपकी मंज़ूरी के बिना कुछ नहीं भेजा जाता: शिकायत खोलें, 'एस्केलेशन ईमेल देखें' के नीचे पढ़ें, चाहें तो बदलें, फिर 'ईमेल भेजें' — या 'न भेजें' दबाएँ। अगर दफ़्तर को अपने-आप ईमेल नहीं हो सकता तो 'एस्केलेशन पत्र तैयार' दिखेगा: 'कॉपी' दबाकर खुद भेजें। एस्केलेशन अपने-आप शुरू होता है; इसे पहले शुरू करने का कोई बटन नहीं है।`,
    }),
  },
  {
    id: 'is_it_fixed',
    about: '"Is it fixed?" question, marking a complaint resolved/fixed, "Yes, fixed" / "Not yet"',
    patterns: [/\bis it fixed\b/, /\byes,? fixed\b/, /\bnot yet\b.*\b(button|mean|tap)\b/, /\bmark\b.{0,25}\b(fixed|resolved|solved|done)\b/, /\b(problem|issue) (is|was|got|has been) (fixed|solved|resolved)\b/, /పరిష్కారమైందా|क्या ठीक हो गया|ठीक हो गई/],
    answer: () => ({
      en: "A day after filing, the complaint asks 'Is it fixed?'. Tap 'Yes, fixed' once the problem is really fixed — the complaint is marked Resolved and everyone who tapped 'Me too' is told. Tap 'Not yet' if it isn't; Nagrik keeps checking and escalates if needed.",
      te: "నమోదైన ఒక రోజు తర్వాత ఫిర్యాదులో 'పరిష్కారమైందా?' అని అడుగుతుంది. సమస్య నిజంగా పరిష్కారమైతే 'అవును' నొక్కండి — ఫిర్యాదు పరిష్కారమైనట్లు గుర్తించబడుతుంది, 'నేను కూడా' నొక్కిన వారందరికీ తెలియజేస్తాం. కాకపోతే 'ఇంకా లేదు' నొక్కండి; నాగరిక్ చెక్ చేస్తూనే ఉంటుంది, అవసరమైతే ఎస్కలేట్ చేస్తుంది.",
      hi: "दर्ज होने के एक दिन बाद शिकायत पर 'क्या ठीक हो गया?' पूछा जाता है। समस्या सच में ठीक होने पर 'हाँ, ठीक हुआ' दबाएँ — शिकायत हल मानी जाती है और 'मैं भी' दबाने वाले सभी लोगों को बताया जाता है। अगर नहीं हुई, तो 'अभी नहीं' दबाएँ; नागरिक जाँच करता रहेगा और ज़रूरत हो तो आगे बढ़ाएगा।",
    }),
  },
  {
    id: 'test_portal',
    about: '"Test portal" badge, practice/sandbox portal, test version banner, whether the complaint reaches the real office',
    patterns: [/\btest (portal|version|mode)\b/, /\bsandbox\b/, /\bpractice portal\b/, /\b(real|actual) (government|office|department)\b/, /టెస్ట్ పోర్టల్|टेस्ट पोर्टल/],
    answer: () => ({
      en: "'Test portal' means this office isn't connected to its real government portal in Nagrik yet. During this pilot, complaints to it go to Nagrik's practice portal, not to the real office. If the problem is urgent, please also contact the office directly.",
      te: "'టెస్ట్ పోర్టల్' అంటే ఈ కార్యాలయం ఇంకా నాగరిక్‌లో అసలైన ప్రభుత్వ పోర్టల్‌తో అనుసంధానం కాలేదు. ఈ పైలట్ సమయంలో దానికి వెళ్ళే ఫిర్యాదులు నాగరిక్ ప్రాక్టీస్ పోర్టల్‌కు వెళ్తాయి, అసలు కార్యాలయానికి కాదు. సమస్య అత్యవసరమైతే, కార్యాలయాన్ని నేరుగా కూడా సంప్రదించండి.",
      hi: "'टेस्ट पोर्टल' का मतलब है यह दफ़्तर अभी नागरिक में अपने असली सरकारी पोर्टल से जुड़ा नहीं है। इस पायलट के दौरान इसकी शिकायतें नागरिक के अभ्यास पोर्टल पर जाती हैं, असली दफ़्तर में नहीं। समस्या ज़रूरी हो तो दफ़्तर से सीधे भी संपर्क करें।",
    }),
  },
  {
    id: 'me_too',
    about: '"Me too" support, "Already reported nearby", duplicates, "It\'s a different problem", Nearby tab, supporting someone else\'s complaint',
    patterns: [/\bme too\b/, /\balready reported\b/, /\bduplicate\b/, /\bdifferent problem\b/, /\bnearby\b/, /\bsupport(ing|ers?)?\b.{0,20}\bcomplaint\b/, /నేను కూడా|సమీపంలో|मैं भी|आसपास/],
    answer: () => ({
      en: "If someone nearby already reported the same problem, the app shows it before filing: tap 'Me too — add my support' to join that complaint (one strong complaint works better than many), or 'It's a different problem' to file your own. You can also open the Nearby tab and tap 'Me too' on any issue. Supporters get every update; the reporter handles filing.",
      te: "దగ్గర్లో ఎవరైనా ఇదే సమస్యను ఇప్పటికే నివేదించి ఉంటే, నమోదుకు ముందే యాప్ చూపిస్తుంది: ఆ ఫిర్యాదులో చేరడానికి 'నేను కూడా — మద్దతు ఇవ్వండి' నొక్కండి (చాలా చిన్నవాటికంటే ఒక బలమైన ఫిర్యాదు మేలు), లేదా మీ సొంతది నమోదు చేయడానికి 'ఇది వేరే సమస్య' నొక్కండి. 'సమీపంలో' ట్యాబ్‌లో ఏ సమస్యకైనా 'నేను కూడా' నొక్కవచ్చు. మద్దతుదారులకు ప్రతి అప్‌డేట్ వస్తుంది; నమోదు నివేదించినవారు చూసుకుంటారు.",
      hi: "अगर पास में किसी ने यही समस्या पहले से दर्ज की है, तो ऐप दर्ज करने से पहले दिखाता है: उस शिकायत से जुड़ने के लिए 'मैं भी — समर्थन जोड़ें' दबाएँ (कई छोटी शिकायतों से एक मज़बूत शिकायत बेहतर है), या अपनी अलग शिकायत के लिए 'यह अलग समस्या है' दबाएँ। 'आसपास' टैब में किसी भी समस्या पर 'मैं भी' दबा सकते हैं। समर्थकों को हर अपडेट मिलता है; दर्ज करना रिपोर्ट करने वाला संभालता है।",
    }),
  },
  {
    id: 'wrong_info',
    about: 'the app picked the wrong department, wrong issue type/category, or wrong location/address',
    patterns: [/\bwrong (department|office|issue|type|category|location|address|place|city)\b/, /\b(department|location|address|category) (is|was) wrong\b/, /తప్పు (శాఖ|చిరునామా|లొకేషన్)|गलत (विभाग|पता|लोकेशन|श्रेणी)/],
    answer: () => ({
      en: "If the department, issue type or location looks wrong and the complaint isn't filed yet, open it, tap 'Withdraw complaint', and report again with a clearer photo, the exact address and a short note. If it's already filed, tap 'Email support' and send us the reference number — we'll check it.",
      te: "శాఖ, సమస్య రకం లేదా లొకేషన్ తప్పుగా ఉండి, ఫిర్యాదు ఇంకా నమోదు కాకపోతే, దాన్ని తెరిచి 'ఫిర్యాదు ఉపసంహరించండి' నొక్కి, స్పష్టమైన ఫోటో, సరైన చిరునామా, చిన్న వివరణతో మళ్ళీ నివేదించండి. ఇప్పటికే నమోదైతే, 'ఈమెయిల్ సపోర్ట్' నొక్కి రిఫరెన్స్ నంబర్ పంపండి — మేము చూస్తాం.",
      hi: "अगर विभाग, समस्या का प्रकार या लोकेशन गलत लगे और शिकायत अभी दर्ज नहीं हुई है, तो उसे खोलें, 'शिकायत वापस लें' दबाएँ, और साफ़ फ़ोटो, सही पते और छोटे विवरण के साथ फिर से दर्ज करें। अगर दर्ज हो चुकी है, तो 'ईमेल सपोर्ट' दबाकर रेफ़रेंस नंबर भेजें — हम देखेंगे।",
    }),
  },
  {
    id: 'sign_in',
    about: 'signing in / login, the email code not arriving, code expired or wrong, changing email',
    patterns: [/\b(sign.?in|log.?in|login)\b/, /\b(verification|sign.?in|login|email) code\b/, /\bcode (is )?(not|never|didn.?t|does ?n.?t) (come|arrive|received|work)/, /\b(didn.?t|not) (get|receive) (the |a |my )?code\b/, /సైన్ ఇన్|లాగిన్|కోడ్ రాలేదు|लॉग ?इन|साइन ?इन|कोड नहीं (आया|मिला)/],
    answer: () => ({
      en: "Sign-in uses a one-time code sent to your email — there's no password. If the code doesn't arrive, check your Spam or Promotions folder, make sure the email address is right, and tap 'Resend code' when the timer ends. Always use the newest code.",
      te: "సైన్ ఇన్ కోసం మీ ఇమెయిల్‌కు ఒకసారి వాడే కోడ్ వస్తుంది — పాస్‌వర్డ్ ఉండదు. కోడ్ రాకపోతే, Spam లేదా Promotions ఫోల్డర్ చూడండి, ఇమెయిల్ అడ్రస్ సరైనదేనా చూసుకోండి, టైమర్ అయిపోయాక 'కోడ్ మళ్ళీ పంపండి' నొక్కండి. ఎప్పుడూ తాజా కోడ్‌నే వాడండి.",
      hi: "साइन इन के लिए आपके ईमेल पर एक बार का कोड आता है — कोई पासवर्ड नहीं है। कोड न आए तो Spam या Promotions फ़ोल्डर देखें, ईमेल पता सही है यह जाँचें, और टाइमर खत्म होने पर 'कोड दोबारा भेजें' दबाएँ। हमेशा सबसे नया कोड इस्तेमाल करें।",
    }),
  },
  {
    id: 'profile',
    about: 'changing name, mobile number or profile photo',
    patterns: [/\b(change|edit|update|correct|add)\b.{0,15}\b(my )?(name|mobile|phone|number|photo|picture|avatar|dp)\b/, /\bprofile (photo|picture|pic)\b/, /పేరు మార్చ|మొబైల్ నంబర్ మార్చ|ఫోటో మార్చ|नाम बदल|मोबाइल (नंबर )?बदल|फ़ोटो बदल/],
    answer: () => ({
      en: "Open the Profile tab and tap your name card to change your name or mobile number. Tap the photo circle to set or change your profile photo. Government offices need your correct name and 10-digit mobile number to register complaints.",
      te: "పేరు లేదా మొబైల్ నంబర్ మార్చడానికి ప్రొఫైల్ ట్యాబ్ తెరిచి మీ పేరు ఉన్న కార్డ్‌ను నొక్కండి. ప్రొఫైల్ ఫోటో కోసం ఫోటో వృత్తాన్ని నొక్కండి. ఫిర్యాదు నమోదుకు ప్రభుత్వ కార్యాలయాలకు మీ సరైన పేరు, 10 అంకెల మొబైల్ నంబర్ అవసరం.",
      hi: "नाम या मोबाइल नंबर बदलने के लिए प्रोफ़ाइल टैब खोलें और अपने नाम वाले कार्ड को दबाएँ। प्रोफ़ाइल फ़ोटो के लिए फ़ोटो वाले गोले को दबाएँ। शिकायत दर्ज करने के लिए सरकारी दफ़्तरों को आपका सही नाम और 10 अंकों का मोबाइल नंबर चाहिए।",
    }),
  },
  {
    id: 'language',
    about: 'changing the app language (English, Telugu, Hindi)',
    patterns: [/\b(change|switch|set)\b.{0,15}\blanguage\b/, /\blanguage\b.{0,15}\b(change|switch|setting)\b/, /\bin (telugu|hindi|english)\b.*\b(app|use|change)\b/, /భాష మార్చ|भाषा बदल/],
    answer: () => ({
      en: 'Open Profile → Language and choose English, Telugu or Hindi. You can also type or speak your complaint details in any of these languages.',
      te: 'ప్రొఫైల్ → భాష తెరిచి English, తెలుగు లేదా हिन्दी ఎంచుకోండి. ఫిర్యాదు వివరాలను ఈ భాషల్లో దేనిలోనైనా టైప్ చేయవచ్చు లేదా మాట్లాడవచ్చు.',
      hi: 'प्रोफ़ाइल → भाषा खोलें और English, తెలుగు या हिन्दी चुनें। शिकायत का विवरण इनमें से किसी भी भाषा में लिख या बोल सकते हैं।',
    }),
  },
  {
    id: 'notifications',
    about: 'notifications / alerts not coming, turning them on or off, the Updates tab',
    patterns: [/\bnotification/, /\b(alerts?|push)\b.{0,20}\b(not|no|never|turn|enable)\b/, /నోటిఫికేషన్|सूचना|नोटिफ़िकेशन/],
    answer: () => ({
      en: "Open Profile → Notifications to turn them on. If you blocked them earlier, the app opens your phone's Settings — allow notifications for Nagrik there. You're told when a complaint is filed, updated, escalated or resolved, and everything also appears in the Updates tab.",
      te: "నోటిఫికేషన్లు ఆన్ చేయడానికి ప్రొఫైల్ → నోటిఫికేషన్లు తెరవండి. ఇంతకు ముందు బ్లాక్ చేసి ఉంటే, యాప్ మీ ఫోన్ సెట్టింగ్స్ తెరుస్తుంది — అక్కడ నాగరిక్‌కు అనుమతి ఇవ్వండి. ఫిర్యాదు నమోదైనప్పుడు, అప్‌డేట్ అయినప్పుడు, ఎస్కలేట్ అయినప్పుడు లేదా పరిష్కారమైనప్పుడు మీకు తెలియజేస్తాం; అన్నీ అప్‌డేట్స్ ట్యాబ్‌లో కూడా ఉంటాయి.",
      hi: "सूचनाएँ चालू करने के लिए प्रोफ़ाइल → सूचनाएँ खोलें। अगर पहले बंद कर दी थीं, तो ऐप आपके फ़ोन की सेटिंग्स खोलेगा — वहाँ नागरिक को अनुमति दें। शिकायत दर्ज होने, अपडेट होने, आगे बढ़ने या हल होने पर आपको बताया जाता है; सब कुछ अपडेट्स टैब में भी दिखता है।",
    }),
  },
  {
    id: 'delete_account',
    about: 'deleting the whole account and all data',
    patterns: [/\b(delete|remove|close|deactivate)\b.{0,15}\baccount\b/, /\baccount\b.{0,15}\b(delete|deletion|remove)\b/, /\b(delete|erase|remove) (all )?my data\b/, /ఖాతా తొలగించ|అకౌంట్ (డిలీట్|తొలగ)|खाता हटा|अकाउंट (डिलीट|हटा)/],
    answer: () => ({
      en: "Open Profile → 'Delete account' → 'Delete everything'. This removes your account, complaints, photos and notifications from Nagrik. Complaints already filed with a government office stay in that office's own system. You can also ask for deletion by tapping 'Email support'.",
      te: "ప్రొఫైల్ → 'ఖాతా తొలగించండి' → 'అన్నీ తొలగించండి' నొక్కండి. ఇది మీ ఖాతా, ఫిర్యాదులు, ఫోటోలు, నోటిఫికేషన్లను నాగరిక్ నుండి తొలగిస్తుంది. ప్రభుత్వ కార్యాలయంలో ఇప్పటికే నమోదైన ఫిర్యాదులు ఆ కార్యాలయ వ్యవస్థలోనే ఉంటాయి. 'ఈమెయిల్ సపోర్ట్' ద్వారా కూడా తొలగింపు కోరవచ్చు.",
      hi: "प्रोफ़ाइल → 'खाता हटाएँ' → 'सब कुछ हटाएँ' दबाएँ। इससे आपका खाता, शिकायतें, फ़ोटो और सूचनाएँ नागरिक से हट जाती हैं। सरकारी दफ़्तर में पहले से दर्ज शिकायतें उस दफ़्तर के सिस्टम में रहती हैं। 'ईमेल सपोर्ट' से भी हटाने का अनुरोध कर सकते हैं।",
    }),
  },
  {
    id: 'privacy',
    about: 'privacy, who sees my name/phone/photos, data sharing, AI processing',
    patterns: [/\bprivacy\b/, /\bwho (can )?(see|sees)\b/, /\b(share|sharing|sell)\b.{0,20}\b(my )?(data|name|number|phone|mobile|details)\b/, /\bmy (data|details|information)\b.{0,20}\b(safe|used|go)\b/, /గోప్యత|నా వివరాలు ఎవరు|गोपनीयता|मेरा डेटा/],
    answer: () => ({
      en: "Your name and mobile number are shared only with the government office handling your complaint — when it's filed, or when you approve an escalation. Photos and complaint text are processed by Google Gemini (AI) to write the complaint. Nagrik shows no ads and doesn't sell data. Full details: Profile → Your privacy.",
      te: "మీ పేరు, మొబైల్ నంబర్ మీ ఫిర్యాదును చూసే ప్రభుత్వ కార్యాలయంతో మాత్రమే పంచుకుంటాం — ఫిర్యాదు నమోదైనప్పుడు లేదా మీరు ఎస్కలేషన్ ఆమోదించినప్పుడు. ఫిర్యాదు రాయడానికి ఫోటోలు, వివరాలను Google Gemini (AI) ప్రాసెస్ చేస్తుంది. నాగరిక్ ప్రకటనలు చూపదు, డేటా అమ్మదు. పూర్తి వివరాలు: ప్రొఫైల్ → మీ గోప్యత.",
      hi: "आपका नाम और मोबाइल नंबर सिर्फ़ आपकी शिकायत देखने वाले सरकारी दफ़्तर से साझा होता है — शिकायत दर्ज होने पर या आपके एस्केलेशन मंज़ूर करने पर। शिकायत लिखने के लिए फ़ोटो और विवरण Google Gemini (AI) प्रोसेस करता है। नागरिक विज्ञापन नहीं दिखाता और डेटा नहीं बेचता। पूरी जानकारी: प्रोफ़ाइल → आपकी गोपनीयता।",
    }),
  },
  {
    id: 'slow_app',
    about: 'app slow, stuck loading, "Waking up the server", "Can\'t reach Nagrik", errors connecting',
    patterns: [/\b(app|nagrik|screen|page)\b.{0,25}\b(slow|stuck|loading|hangs?|hanging|frozen|crash(es|ed|ing)?|not (loading|opening|responding))\b/, /\b(keeps|kept|still|always) loading\b/, /\bwaking up\b/, /\bcan.?t reach\b/, /\bserver\b/, /యాప్ (నెమ్మది|లోడ్)|ऐप (धीमा|लोड नहीं|नहीं खुल)/],
    answer: () => ({
      en: "Nagrik's server sleeps when nobody is using it, so the first action can take up to a minute ('Waking up the server…'). Please wait and try again. If it keeps failing for more than a few minutes, check your internet connection, then tap 'Email support'.",
      te: "ఎవరూ వాడనప్పుడు నాగరిక్ సర్వర్ నిద్రలోకి వెళ్తుంది, కాబట్టి మొదటి పని ఒక నిమిషం వరకు పట్టవచ్చు. కాస్త ఆగి మళ్ళీ ప్రయత్నించండి. కొన్ని నిమిషాలకు పైగా పని చేయకపోతే, మీ ఇంటర్నెట్ చూసుకుని, 'ఈమెయిల్ సపోర్ట్' నొక్కండి.",
      hi: "जब कोई इस्तेमाल नहीं करता तो नागरिक का सर्वर सो जाता है, इसलिए पहला काम एक मिनट तक ले सकता है। थोड़ा रुककर फिर कोशिश करें। अगर कुछ मिनट से ज़्यादा समय तक काम न करे, तो अपना इंटरनेट जाँचें, फिर 'ईमेल सपोर्ट' दबाएँ।",
    }),
  },
  {
    id: 'location',
    about: 'location not detected / wrong GPS / typing the address manually / camera or location permission',
    patterns: [/\blocation\b.{0,25}\b(not|wrong|off|denied|permission|detect|found)\b/, /\b(gps|location permission|camera permission)\b/, /\benter address\b/, /లొకేషన్|స్థానం రావడం లేదు|लोकेशन|जगह नहीं/],
    answer: () => ({
      en: "If your location isn't found, allow location permission for Nagrik in your phone's Settings, or tap 'Enter address manually' and type the street, a landmark, the town and the PIN code. For the camera, allow camera permission in Settings, or tap 'Choose from gallery'.",
      te: "లొకేషన్ రాకపోతే, ఫోన్ సెట్టింగ్స్‌లో నాగరిక్‌కు లొకేషన్ అనుమతి ఇవ్వండి, లేదా 'చిరునామా టైప్ చేయండి' నొక్కి వీధి, గుర్తు, ఊరు, PIN కోడ్ టైప్ చేయండి. కెమెరా కోసం సెట్టింగ్స్‌లో కెమెరా అనుమతి ఇవ్వండి, లేదా 'గ్యాలరీ నుండి ఎంచుకోండి' నొక్కండి.",
      hi: "अगर लोकेशन नहीं मिल रही, तो फ़ोन की सेटिंग्स में नागरिक को लोकेशन की अनुमति दें, या 'पता खुद लिखें' दबाकर गली, कोई पहचान की जगह, शहर और PIN कोड लिखें। कैमरे के लिए सेटिंग्स में कैमरा अनुमति दें, या 'गैलरी से चुनें' दबाएँ।",
    }),
  },
  {
    id: 'about',
    about: 'what Nagrik is, whether it is a government app, whether it is free, who runs it',
    patterns: [/\bwhat is nagrik\b/, /\b(is (this|it|nagrik)) (a )?(government|govt|official)\b/, /\b(is (it|this|nagrik) free|any (charge|fee|cost)|do i (have to )?pay)\b/, /\bwho (runs|made|owns|built)\b/, /నాగరిక్ అంటే|ప్రభుత్వ యాప్|ఉచితమా|नागरिक क्या है|सरकारी ऐप|मुफ़्त|फ्री है/],
    answer: () => ({
      en: 'Nagrik is a free, independent app — it is not run by or affiliated with any government body. It writes your complaint, files it with the responsible office, follows up and escalates when needed.',
      te: 'నాగరిక్ ఉచితమైన, స్వతంత్ర యాప్ — దీనికి ఏ ప్రభుత్వ సంస్థతోనూ సంబంధం లేదు. ఇది మీ ఫిర్యాదు రాసి, సంబంధిత కార్యాలయంలో నమోదు చేసి, ఫాలో-అప్ చేసి, అవసరమైతే ఎస్కలేట్ చేస్తుంది.',
      hi: 'नागरिक एक मुफ़्त, स्वतंत्र ऐप है — यह किसी सरकारी संस्था का नहीं है और न उससे जुड़ा है। यह आपकी शिकायत लिखता है, सही दफ़्तर में दर्ज करता है, फ़ॉलो-अप करता है और ज़रूरत हो तो आगे बढ़ाता है।',
    }),
  },
];

export const TOPIC_IDS = HELP_TOPICS.map((t) => t.id);

export const FIXED_REPLIES: Record<'off_topic' | 'not_sure' | 'no_complaints' | 'which_complaint', Answer> = {
  off_topic: {
    en: "I can only help with Nagrik and your complaints. Ask me about reporting a problem, your complaint's status, escalation or your account.",
    te: 'నేను నాగరిక్, మీ ఫిర్యాదుల విషయంలో మాత్రమే సహాయం చేయగలను. సమస్య నివేదించడం, ఫిర్యాదు స్థితి, ఎస్కలేషన్ లేదా మీ ఖాతా గురించి అడగండి.',
    hi: 'मैं सिर्फ़ नागरिक और आपकी शिकायतों में मदद कर सकता हूँ। समस्या दर्ज करने, शिकायत की स्थिति, एस्केलेशन या अपने खाते के बारे में पूछें।',
  },
  not_sure: {
    en: "I'm not sure about that, and I don't want to guess. Please tap 'Email support' — a person will reply.",
    te: 'దీని గురించి నాకు ఖచ్చితంగా తెలియదు, ఊహించి చెప్పదలచుకోలేదు. దయచేసి \'ఈమెయిల్ సపోర్ట్\' నొక్కండి — ఒక వ్యక్తి జవాబిస్తారు.',
    hi: "मुझे इसके बारे में पक्का नहीं पता, और मैं अंदाज़ा नहीं लगाना चाहता। कृपया 'ईमेल सपोर्ट' दबाएँ — कोई व्यक्ति जवाब देगा।",
  },
  no_complaints: {
    en: "You haven't reported any complaints yet. Tap 'Report an issue' on Home to report your first one.",
    te: "మీరు ఇంకా ఏ ఫిర్యాదూ నివేదించలేదు. మొదటిది నివేదించడానికి హోమ్‌లో 'సమస్యను నివేదించండి' నొక్కండి.",
    hi: "आपने अभी तक कोई शिकायत दर्ज नहीं की है। पहली शिकायत के लिए होम पर 'समस्या बताएँ' दबाएँ।",
  },
  which_complaint: {
    en: 'Here are your latest complaints. To ask about a different one, mention its reference number.',
    te: 'ఇవి మీ తాజా ఫిర్యాదులు. వేరే దాని గురించి అడగాలంటే, దాని రిఫరెన్స్ నంబర్ చెప్పండి.',
    hi: 'ये आपकी ताज़ा शिकायतें हैं। किसी और के बारे में पूछना हो तो उसका रेफ़रेंस नंबर लिखें।',
  },
};

/** Plain-text guide for the AI fallback, built from the same approved answers (single source of truth). */
export function helpGuide() {
  return HELP_TOPICS.map((t) => `## ${t.about}\n${t.answer().en}`).join('\n\n');
}

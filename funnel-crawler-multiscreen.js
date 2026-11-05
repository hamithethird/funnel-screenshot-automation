const { chromium } = require('playwright');
const { findEvaluationDropdown, chooseEvaluationDropdown } = require('./evaluation-select');
const { rejectCookieOverlays, isCookieAcceptanceText, hasCookieContext, readCookieActionState } = require('./cookie-consent');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RUN_PASSWORD = '***REMOVED***';
const BASE_RUN_EMAIL = 'REMOVED_EMAIL';
const FALLBACK_RUN_EMAIL = 'REMOVED_EMAIL';

// Page text and Playwright errors can echo filled values. Redact all crawler logs.
function redactCrawlerLog(...args) {
  return require('util').format(...args).split(RUN_PASSWORD).join('[REDACTED]');
}
const console = {
  log: (...args) => globalThis.console.log(redactCrawlerLog(...args)),
  error: (...args) => globalThis.console.error(redactCrawlerLog(...args))
};

function createRunCredentials() {
  let email = BASE_RUN_EMAIL;
  return {
    currentRunEmail: () => email,
    advanceRunEmail: () => {
      if (email !== BASE_RUN_EMAIL) return null;
      email = FALLBACK_RUN_EMAIL;
      return email;
    }
  };
}

function genericFormFieldType(info, visibleFormIntent = '') {
  const signals = [info.name, info.placeholder, info.autocomplete, info.ariaLabel, info.label].join(' ');
  // Field-specific metadata wins over page copy, particularly on combined signup forms.
  if (info.type === 'password' || ['new-password', 'current-password'].includes(info.autocomplete) ||
      /\b(password|passcode|create[\s_-]*password|confirm[\s_-]*password)\b/i.test(signals)) return 'password';
  if (info.type === 'email' || info.autocomplete === 'email' || /\be-?mail\b/i.test(signals)) return 'email';
  if (['name', 'given-name', 'first-name'].includes(info.autocomplete) ||
      /\b(first[\s_-]*name|your[\s_-]*name|name)\b/i.test(signals)) return 'name';
  if (/\b(password|passcode)\b/i.test(visibleFormIntent)) return 'password';
  if (/\be-?mail\b/i.test(visibleFormIntent)) return 'email';
  return null;
}

function isEmailRejection(text) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  return [
    /(?:email|e-mail|email address).{0,80}(?:already|previously).{0,40}(?:used|taken|registered|exists?|in use|associated|linked)/i,
    /(?:already|previously).{0,40}(?:used|taken|registered|exists?|in use|associated|linked).{0,80}(?:email|e-mail)/i,
    /(?:account|user).{0,60}(?:already exists|already registered|already in use)/i,
    /duplicate\s+(?:email|account|user)/i,
    /(?:invalid|unsupported|blocked|rejected|not allowed|not accepted|not supported|cannot (?:use|accept)).{0,40}(?:e-?mail|domain)/i,
    /(?:e-?mail|domain).{0,60}(?:invalid|unsupported|blocked|rejected|not allowed|not accepted|not supported|cannot be used)/i,
    /(?:enter|provide|use).{0,20}(?:valid|different|another).{0,20}e-?mail/i
  ].some(pattern => pattern.test(normalized));
}

function isNativeLanguageQuestion(text) {
  const normalized = (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const patterns = [
    'native language', 'first language', 'mother tongue', 'mother language',
    'language do you speak', 'language you speak', 'your main language', 'primary language'
  ];
  return patterns.some(pattern => normalized.includes(pattern));
}

function choosePreferredNativeLanguage(options) {
  const normalized = options.map((option, index) => ({
    ...option,
    originalIndex: index,
    normalizedText: (option.text || '').trim().toLowerCase()
  }));
  const englishNames = ['english', 'ingilizce', 'inglés', 'ingles', 'anglais', 'englisch', 'inglese'];
  const spanishNames = ['spanish', 'español', 'espanol', 'ispanyolca', 'espagnol', 'spanisch', 'spagnolo'];

  const english = normalized.find(option =>
    englishNames.some(name => option.normalizedText === name || option.normalizedText.includes(name))
  );
  if (english) return { option: english, reason: 'Preferred native language: English' };

  const spanish = normalized.find(option =>
    spanishNames.some(name => option.normalizedText === name || option.normalizedText.includes(name))
  );
  if (spanish) return { option: spanish, reason: 'English unavailable; fallback native language: Spanish' };

  return null;
}

function parseNumberToken(token) {
  const words = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10
  };
  if (/^\d+$/.test(token || '')) return Number(token);
  return words[(token || '').toLowerCase()] || null;
}

function getSelectionInstruction(text) {
  const normalized = (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const number = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';
  let match;

  match = normalized.match(new RegExp(`(?:choose|select|pick)\\s+(?:at\\s+least\\s+)?${number}\\s+(?:or\\s+more|or\\s+above|\\+)`));
  if (match) {
    const n = parseNumberToken(match[1]);
    return { minSelections: n || 1, maxSelections: null, reason: match[0] };
  }

  match = normalized.match(new RegExp(`(?:at\\s+least|minimum\\s+of?)\\s+${number}`));
  if (match) {
    const n = parseNumberToken(match[1]);
    return { minSelections: n || 1, maxSelections: null, reason: match[0] };
  }

  match = normalized.match(new RegExp(`${number}\\s+(?:or\\s+more|or\\s+above)`));
  if (match) {
    const n = parseNumberToken(match[1]);
    return { minSelections: n || 1, maxSelections: null, reason: match[0] };
  }

  match = normalized.match(new RegExp(`(?:choose|select|pick)\\s+(?:up\\s+to|no\\s+more\\s+than|max(?:imum)?\\s+of?)\\s+${number}`));
  if (match) {
    const n = parseNumberToken(match[1]);
    return { minSelections: 1, maxSelections: n || null, reason: match[0] };
  }

  match = normalized.match(new RegExp(`(?:choose|select|pick)\\s+(?:exactly\\s+)?${number}(?!\\s+(?:or|to))`));
  if (match) {
    const n = parseNumberToken(match[1]);
    if (n) return { minSelections: n, maxSelections: n, reason: match[0] };
  }

  if (/\b(select all that apply|choose all that apply|select any that apply|choose any that apply)\b/.test(normalized)) {
    return { minSelections: 1, maxSelections: null, reason: 'multi-select instruction' };
  }

  return { minSelections: 1, maxSelections: 1, reason: 'default single selection' };
}

function isPassiveTransitionScreen(text) {
  const normalized = (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const passiveSignals = [
    /\b(crafting|creating|generating|building|preparing|personalizing|personalising|analyzing|analysing|processing|loading|calculating|finalizing|finalising|matching|assessing|evaluating|scoring|tailoring|compiling)\b/,
    /\b(putting together|setting up)\b/,
    /\bplease wait\b/,
    // "Almost there" is commonly a section/header label on active forms
    // (for example BetterMe height/weight/name steps). It must not by itself
    // classify a page as passive. Only the stronger completion phrases remain.
    /\balmost (?:done|ready)\b/,
    /\bhang tight\b/,
    /\bthis may take (?:a|few|some) (?:moment|moments|second|seconds|minute|minutes)\b/
  ];

  return passiveSignals.some(pattern => pattern.test(normalized));
}

function isNonBranchProfileQuestion(text) {
  const normalized = (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  // These are ordinary profile/setup questions whose answers normally just move
  // the funnel forward. Branch probing is harmful on stateful SPAs because the
  // exact question may not be restorable after the first answer.
  const profilePatterns = [
    /\bphysical build\b/,
    /\bbody (?:type|shape|build)\b/,
    /\bhow would you describe your (?:body|build|physique)\b/,
    /\b(?:your )?(?:height|weight|age|gender|sex)\b/,
    /\bhow (?:tall|old) are you\b/,
    /\bwhat is your (?:height|weight|age|gender)\b/
  ];
  return profilePatterns.some(pattern => pattern.test(normalized));
}

function isSpeechInputScreen(text) {
  const normalized = (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  // Only classify a page as requiring spoken/audio input when the page actually
  // asks the user to perform a speech/recording action. Mere questionnaire copy
  // such as "I needed more speaking practice" must NOT disable branch exploration.
  const hardSpeechSignals = [
    /\b(microphone|enable (?:your )?mic|allow microphone|record(?:ing)? (?:your )?(?:voice|answer)|start recording|stop recording)\b/,
    /\b(voice assessment|speech assessment|speaking assessment|pronunciation test|quick call|ai tutor call)\b/,
    /\b(say (?:this|it|something|the sentence)|say .* aloud|read .* aloud|speak (?:now|into|for|the following)|please speak|start speaking)\b/
  ];
  return hardSpeechSignals.some(pattern => pattern.test(normalized));
}

const skipEscapePattern = /^(skip|skip for now|not now|maybe later|later|do this later|do it later|continue without(?: this)?|continue without speaking|no thanks|no, thanks|i'll do this later|i will do this later)$/i;
const strongNavigationPattern = /^(continue|next|proceed|submit|done|finish|start|see results?|get started|create account|sign up|go on|keep going|move on|let(?:'|’)s continue|let(?:'|’)s go|devam|devam et|ileri)$/i;

function hasSkipEscapeChoice(state) {
  if (!state) return false;
  const texts = [state.cta?.text || '', ...(state.group || []).map(item => item.text || '')];
  return texts.some(text => skipEscapePattern.test(text.trim()));
}

function isStrongNavigationText(text) {
  return strongNavigationPattern.test((text || '').trim());
}

function shouldFollowProfileContinue(state, visibleFieldCount) {
  return visibleFieldCount === 0 && !!state?.cta && isStrongNavigationText(state.cta.text);
}

function branchLetter(index) {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function normalizeContextText(text, removeTexts = []) {
  let normalized = (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}%]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const item of removeTexts) {
    const remove = (item || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}%]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (remove.length >= 2) normalized = normalized.split(remove).join(' ');
  }

  return normalized
    .replace(/\b(continue|next|back|skip|ileri|devam|geri)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function contextSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const numericA = a.match(/\b\d+(?:[.,]\d+)?%?\b/g) || [];
  const numericB = b.match(/\b\d+(?:[.,]\d+)?%?\b/g) || [];
  if (numericA.join('|') !== numericB.join('|')) return 0;

  const tokensA = new Set(a.split(' ').filter(token => token.length > 1));
  const tokensB = new Set(b.split(' ').filter(token => token.length > 1));
  if (!tokensA.size || !tokensB.size) return 0;
  let intersection = 0;
  for (const token of tokensA) if (tokensB.has(token)) intersection++;
  const union = new Set([...tokensA, ...tokensB]).size;
  const jaccard = union ? intersection / union : 0;
  const containment = intersection / Math.min(tokensA.size, tokensB.size);
  return Math.max(jaccard, containment * 0.92);
}

function questionPromptFingerprint(state) {
  if (!state) return '';
  const optionTexts = (state.group || []).map(x => x.text || '').filter(Boolean);
  return normalizeContextText(state.pageText || '', optionTexts);
}

const pureAgeBucketPattern = /^(?:age\s*:?\s*)?(?:<\s*\d{1,3}|>\s*\d{1,3}|\d{1,3}\s*-\s*\d{1,3}|\d{1,3}\s*\+|\d{2}\s*'?s|(?:under|below|less than|over|above|older than)\s*\d{1,3})(?:\s*(?:years?|yrs?)(?:\s*old)?)?$/i;
const ageIntentPattern = /\b(?:choose|select|pick)\s+(?:(?:your|an?)\s+)?age\b|\bhow\s+old\s+are\s+you\b|\bwhat(?:['’]s| is)\s+your\s+age\b|\b(?:your\s+)?age\s+(?:group|range)\b/i;

function hasAgeLabel(text) {
  const label = (text || '').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  return pureAgeBucketPattern.test(label) &&
    (/^age\s*:?\s*/i.test(label) || /\b(?:years?|yrs?)(?:\s+old)?$/i.test(label));
}

function getAgeQuestionEvidence(state) {
  const pageText = (state?.pageText || '').replace(/\s+/g, ' ').trim();
  const explicitAgeIntent = ageIntentPattern.test(pageText);
  const uniqueLabels = [...new Set((state?.group || [])
    .map(option => (option.text || '').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean))];
  const ageLabelCount = uniqueLabels.filter(hasAgeLabel).length;
  const hasAgeLabeledChoices = uniqueLabels.length >= 2 &&
    ageLabelCount >= 2 && ageLabelCount >= Math.ceil(uniqueLabels.length * 0.6);
  return { explicitAgeIntent, hasAgeLabeledChoices };
}

function shouldDeferAgeSelectionToForm(state) {
  return getAgeQuestionEvidence(state).explicitAgeIntent && !(state?.group?.length);
}

function sanitizeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return rawUrl || '';
  }
}

async function runCrawler() {
  const cliArgs = process.argv.slice(2);
  const url = cliArgs[0];
  if (!url) {
    console.error('Please provide a URL.');
    console.error('Usage: node funnel-crawler-multiscreen.js "URL" --vpn off|US|GB|DE|...');
    process.exit(1);
  }

  function readCliOption(name, fallback = null) {
    const index = cliArgs.indexOf(name);
    if (index < 0) return fallback;
    const value = cliArgs[index + 1];
    if (!value || value.startsWith('--')) {
      console.error(`Missing value for ${name}.`);
      process.exit(1);
    }
    return value;
  }

  function normalizeVpnCountry(rawValue) {
    const value = String(rawValue || 'off').trim().toUpperCase();
    if (value === 'OFF' || value === 'NONE' || value === 'NO') return 'OFF';
    if (value === 'UK') return 'GB';
    if (!/^[A-Z]{2}$/.test(value)) {
      console.error('VPN country must be "off" or a two-letter country code such as US, GB, DE, FR, or TR.');
      process.exit(1);
    }
    return value;
  }

  const VPN_COUNTRY = normalizeVpnCountry(readCliOption('--vpn', 'off'));
  const VPN_ENABLED = VPN_COUNTRY !== 'OFF';

  function buildOxylabsProxyConfig() {
    if (!VPN_ENABLED) return null;

    const rawUsername = (process.env.OXY_RES_USERNAME || '').trim();
    const password = (process.env.OXY_RES_PASSWORD || '').trim();

    if (!rawUsername || !password) {
      console.error('VPN mode requires Oxylabs Residential Proxy credentials.');
      console.error('Set OXY_RES_USERNAME and OXY_RES_PASSWORD in your Codespace/GitHub secrets.');
      process.exit(1);
    }

    const baseUsername = rawUsername.replace(/^customer-/i, '');
    const sessionId = crypto.randomBytes(8).toString('hex');
    const username = `customer-${baseUsername}-cc-${VPN_COUNTRY}-sessid-${sessionId}-sesstime-30`;

    return {
      server: 'http://pr.oxylabs.io:7777',
      username,
      password
    };
  }

  async function verifyOxylabsExitCountry(page, expectedCountry) {
    console.log(`VPN mode: ON | Requested exit country: ${expectedCountry}`);
    console.log('Verifying Oxylabs exit location before starting the funnel...');

    const response = await page.goto('https://ip.oxylabs.io/location', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    if (!response || !response.ok()) {
      throw new Error(`Oxylabs location verification failed with HTTP ${response ? response.status() : 'unknown'}.`);
    }

    const bodyText = (await page.locator('body').innerText().catch(() => '')).trim();
    let locationData = null;
    try {
      locationData = JSON.parse(bodyText);
    } catch {
      throw new Error('Oxylabs location verification returned an unreadable response.');
    }

    const providerCountries = Object.values(locationData.providers || {})
      .map(provider => String(provider?.country || '').trim().toUpperCase())
      .filter(country => /^[A-Z]{2}$/.test(country));

    if (!providerCountries.length) {
      throw new Error('Oxylabs location verification did not report a country.');
    }

    const countryCounts = new Map();
    for (const country of providerCountries) {
      countryCounts.set(country, (countryCounts.get(country) || 0) + 1);
    }
    const detectedCountry = [...countryCounts.entries()]
      .sort((a, b) => b[1] - a[1])[0][0];

    const city = Object.values(locationData.providers || {})
      .map(provider => String(provider?.city || '').trim())
      .find(Boolean) || '';

    console.log(`Oxylabs exit IP: ${locationData.ip || '(unknown)'}`);
    console.log(`Detected exit country: ${detectedCountry}${city ? ` | City: ${city}` : ''}`);

    if (detectedCountry !== expectedCountry) {
      throw new Error(`VPN verification failed: requested ${expectedCountry}, but the exit IP was detected as ${detectedCountry}.`);
    }

    console.log('VPN verification: PASSED');
  }

  function deriveFunnelName(rawUrl) {
    try {
      const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
      const labels = hostname.split('.').filter(Boolean);
      const base = labels.length >= 2 ? labels[labels.length - 2] : labels[0] || 'funnel';
      return base.replace(/^get(?=[a-z])/, '').replace(/[^a-z0-9]+/g, ' ').trim() || 'funnel';
    } catch {
      return 'funnel';
    }
  }

  function createRunOutputDirectory(rawUrl) {
    const funnelName = deriveFunnelName(rawUrl);
    let version = 1;
    let dir;
    do {
      dir = path.resolve(process.cwd(), `${funnelName} funnel v${version}`);
      version += 1;
    } while (fs.existsSync(dir));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  let OUTPUT_DIR = createRunOutputDirectory(url);
  console.log('Saving screenshots to:', OUTPUT_DIR);

  const proxyConfig = buildOxylabsProxyConfig();
  if (VPN_ENABLED) {
    console.log(`VPN provider: Oxylabs Residential Proxies | Country: ${VPN_COUNTRY}`);
  } else {
    console.log('VPN mode: OFF | Using the normal Codespace connection.');
  }

  const browser = await chromium.launch(proxyConfig ? { proxy: proxyConfig } : {});
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  if (VPN_ENABLED) {
    try {
      await verifyOxylabsExitCountry(page, VPN_COUNTRY);
    } catch (error) {
      console.error(error?.message || error);
      await browser.close().catch(() => {});
      process.exit(1);
    }
  }

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });


  function deriveBrandName(rawUrl) {
    try {
      const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
      const labels = hostname.split('.').filter(Boolean);
      const base = labels.length >= 2 ? labels[labels.length - 2] : labels[0] || 'funnel';
      const cleaned = base.replace(/^get(?=[a-z])/, '').replace(/[^a-z0-9-]+/g, '-');
      return (cleaned.split('-').filter(Boolean)[0] || 'funnel').trim();
    } catch {
      return 'funnel';
    }
  }

  async function inferFunnelTopicFromFirstPage() {
    const text = await page.evaluate(() => {
      const visible = el => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0;
      };
      const pieces = [];
      for (const el of document.querySelectorAll('h1, h2, h3, [role="heading"], main, body')) {
        if (!visible(el)) continue;
        const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) pieces.push(t);
      }
      return pieces.join(' ').slice(0, 7000).toLowerCase();
    }).catch(() => '');

    const topics = [
      ['chinese pilates', /\bchinese\s+pilates\b/],
      ['wall pilates', /\bwall\s+pilates\b/],
      ['chair yoga', /\bchair\s+yoga\b/],
      ['somatic yoga', /\bsomatic\s+yoga\b/],
      ['face yoga', /\bface\s+yoga\b/],
      ['calisthenics', /\bcalisthenics\b/],
      ['pilates', /\bpilates\b/],
      ['yoga', /\byoga\b/],
      ['workout', /\bworkout\b/],
      ['fitness', /\bfitness\b/],
      ['english', /\benglish\b/]
    ];
    for (const [name, pattern] of topics) if (pattern.test(text)) return name;
    return '';
  }

  async function refineOutputDirectoryFromFirstPage() {
    const topic = await inferFunnelTopicFromFirstPage();
    if (!topic) return;
    const brand = deriveBrandName(url);
    const desiredStem = `${brand} ${topic}`.replace(/\s+/g, ' ').trim();
    const currentStem = path.basename(OUTPUT_DIR).replace(/\s+funnel\s+v\d+$/i, '').trim().toLowerCase();
    if (currentStem === desiredStem.toLowerCase()) return;
    let version = 1;
    let target;
    do {
      target = path.resolve(process.cwd(), `${desiredStem} funnel v${version}`);
      version += 1;
    } while (fs.existsSync(target));
    try {
      fs.renameSync(OUTPUT_DIR, target);
      OUTPUT_DIR = target;
      console.log('Refined funnel topic from first-page content. Saving screenshots to:', OUTPUT_DIR);
    } catch (error) {
      console.log('Could not refine output folder name from first-page topic:', error.message);
    }
  }

  await refineOutputDirectoryFromFirstPage();

  const samePageVariantHashes = new Map();
  const samePageSelectionVariantCaptured = new Set();
  function hashScreenshot(buffer) {
    return crypto.createHash('sha1').update(buffer).digest('hex');
  }
  function registerBaseScreenshot(screenNumber, filename) {
    try {
      const buffer = fs.readFileSync(filename);
      const key = String(screenNumber);
      const set = samePageVariantHashes.get(key) || new Set();
      set.add(hashScreenshot(buffer));
      samePageVariantHashes.set(key, set);
    } catch {}
  }
  function nextFreeLetteredFilename(screenNumber) {
    for (let i = 0; i < 200; i++) {
      const candidate = path.join(OUTPUT_DIR, `${String(screenNumber).padStart(2, '0')}${branchLetter(i)}.png`);
      if (!fs.existsSync(candidate)) return candidate;
    }
    return null;
  }
  async function captureSamePageVisualVariant(screenNumber, reason) {
    if (!screenNumber) return null;
    const key = String(screenNumber);
    if (samePageSelectionVariantCaptured.has(key)) {
      console.log(`Selection-state screenshot already captured for ${String(screenNumber).padStart(2, '0')}. Skipping additional selected/unselected visual variants.`);
      return null;
    }
    await page.waitForTimeout(500);
    const buffer = await screenshotBufferNavigationSafe('same-page visual state screenshot');
    const hash = hashScreenshot(buffer);
    const seen = samePageVariantHashes.get(key) || new Set();
    if (seen.has(hash)) return null;
    const filename = nextFreeLetteredFilename(screenNumber);
    if (!filename) return null;
    fs.writeFileSync(filename, buffer);
    seen.add(hash);
    samePageVariantHashes.set(key, seen);
    samePageSelectionVariantCaptured.add(key);
    console.log(`Captured ${path.basename(filename)} as the single representative selection-state screenshot${reason ? `: ${reason}` : '.'}`);
    return filename;
  }
  function answerOutcomeAffinity(answerTexts, landingText) {
    const normalize = value => (value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    const landing = ` ${normalize(landingText)} `;
    const hits = [];
    for (const answer of (answerTexts || [])) {
      const tokens = normalize(answer).split(' ').filter(token => token.length >= 3);
      const matched = tokens.filter(token => landing.includes(` ${token} `));
      if (matched.length) hits.push({ answer, matched });
    }
    return { connected: hits.length > 0, hits };
  }
  async function prepareFullPageCapture() {
    const overlap = await page.evaluate(() => {
      const candidates = [];
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        const st = getComputedStyle(el);
        if (!['fixed', 'sticky'].includes(st.position)) continue;
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.25) continue;
        const r = el.getBoundingClientRect();
        if (r.width < window.innerWidth * 0.45 || r.height < 36 || r.bottom < window.innerHeight * 0.55) continue;
        const x = Math.max(1, Math.min(window.innerWidth - 2, r.left + r.width / 2));
        const y = Math.max(1, Math.min(window.innerHeight - 2, r.top + Math.min(r.height / 2, 40)));
        const stack = document.elementsFromPoint(x, y);
        const underneath = stack.find(node => node !== el && !el.contains(node) && !node.contains(el) && node !== document.body && node !== document.documentElement);
        if (underneath) candidates.push({ tag: el.tagName, text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80) });
      }
      return candidates[0] || null;
    }).catch(() => null);
    if (!overlap) return;
    console.log('Potential sticky/fixed overlap detected before screenshot. Scrolling to see whether it clears:', overlap.text || overlap.tag);
    await page.evaluate(() => window.scrollBy(0, Math.max(240, window.innerHeight * 0.65))).catch(() => {});
    await page.waitForTimeout(650);
    const persists = await page.evaluate(() => Array.from(document.querySelectorAll('body *')).some(el => {
      const st = getComputedStyle(el);
      if (!['fixed', 'sticky'].includes(st.position) || st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.25) return false;
      const r = el.getBoundingClientRect();
      return r.width >= window.innerWidth * 0.45 && r.height >= 36 && r.bottom >= window.innerHeight * 0.55;
    })).catch(() => false);
    if (persists) console.log('Sticky/fixed element remained after scrolling. Capturing the real UI as-is; the overlap may be part of the site itself.');
    else console.log('Overlap cleared after scrolling; capturing the unobstructed full page.');
  }

  function generateRandomAsciiString(length = 16) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return result;
  }

  const { currentRunEmail, advanceRunEmail } = createRunCredentials();
  const supplementalCounterByScreen = new Map();
  const supplementalFingerprintsByScreen = new Map();
  let skipNextNumberedFingerprint = null;
  let currentNumberedCaptureSignature = null;

  function nextSupplementalFilename(screenNumber) {
    const current = supplementalCounterByScreen.get(screenNumber) || 0;
    supplementalCounterByScreen.set(screenNumber, current + 1);
    return path.join(OUTPUT_DIR, `${String(screenNumber).padStart(2, '0')}${branchLetter(current)}.png`);
  }

  function supplementalFingerprintSeen(screenNumber, fingerprint, threshold = 0.95) {
    const seen = supplementalFingerprintsByScreen.get(screenNumber) || [];
    const match = seen.find(existing => contextSimilarity(existing, fingerprint) >= threshold);
    if (match) return true;
    seen.push(fingerprint);
    supplementalFingerprintsByScreen.set(screenNumber, seen);
    return false;
  }

  function supplementalFingerprintSeenExact(screenNumber, fingerprint) {
    const seen = supplementalFingerprintsByScreen.get(screenNumber) || [];
    if (seen.includes(fingerprint)) return true;
    seen.push(fingerprint);
    supplementalFingerprintsByScreen.set(screenNumber, seen);
    return false;
  }

  async function silenceMedia() {
    await page.evaluate(() => {
      for (const media of document.querySelectorAll('audio, video')) {
        try {
          media.muted = true;
          media.volume = 0;
          media.pause();
        } catch {}
      }
    }).catch(() => {});
  }

  async function dismissBlockingConsentOverlay() {
    return await rejectCookieOverlays(page);
  }

  async function safeCrawlerClick(locator, description = 'target') {
    await dismissBlockingConsentOverlay();
    await silenceMedia();
    const cookieContext = await locator.evaluate(readCookieActionState, undefined, { timeout: 1500 }).catch(() => null);
    if (cookieContext?.visible && hasCookieContext(cookieContext.ancestors) &&
        isCookieAcceptanceText(cookieContext.ancestors[0]?.text)) {
      console.log('Cookie acceptance blocked. The crawler only rejects cookies:', description);
      return false;
    }
    try {
      await locator.click({ timeout: 7000 });
      await silenceMedia();
      return true;
    } catch (error) {
      const message = String(error?.message || error);
      if (/intercepts pointer events|another element/i.test(message)) {
        console.log('Click blocked while targeting:', description);
        const dismissed = await dismissBlockingConsentOverlay();
        if (!dismissed) return false;
        console.log('Retrying original click after modal dismissal:', description);
        try {
          await locator.click({ timeout: 7000 });
          await silenceMedia();
          return true;
        } catch (retryError) {
          console.log('Retry failed for:', description, '-', String(retryError?.message || retryError).split('\n')[0]);
          return false;
        }
      }
      if (/Timeout|strict mode violation|waiting for locator|resolved to 0 elements|detached|not attached/i.test(message)) {
        console.log('Click target became stale/unavailable:', description);
        return false;
      }
      throw error;
    }
  }

  // Allow asynchronously mounted CMP banners to appear before capturing screen 1.
  await rejectCookieOverlays(page, { waitForBannerMs: 3500 });
  await silenceMedia();

  async function handleScratchReveal(screenNumber, state) {
    const probe = await page.evaluate(() => {
      const normalize = value => (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const bodyText = normalize(document.body && document.body.innerText || '');
      const scratchWords = /\b(scratch|scratch to reveal|scratch here|reveal your|reveal discount|reveal offer|reveal prize|uncover|rub to reveal)\b/i;
      const pageSuggestsScratch = scratchWords.test(bodyText);
      const candidates = Array.from(document.querySelectorAll(
        'canvas, [class*="scratch" i], [id*="scratch" i], [aria-label*="scratch" i], ' +
        '[class*="reveal" i], [id*="reveal" i], [aria-label*="reveal" i], ' +
        '[class*="prize" i], [id*="prize" i]'
      ));
      const visible = candidates.map((el, index) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const ok = rect.width >= 120 && rect.height >= 70 &&
          rect.bottom > 0 && rect.right > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity) > 0 && style.pointerEvents !== 'none';
        if (!ok) return null;
        const attrs = normalize([
          el.id,
          el.className && String(el.className),
          el.getAttribute('aria-label'),
          el.getAttribute('title')
        ].filter(Boolean).join(' '));
        let score = 0;
        if (scratchWords.test(attrs)) score += 120;
        if (el.tagName.toLowerCase() === 'canvas') score += 40;
        if (pageSuggestsScratch) score += 65;
        if (rect.width >= window.innerWidth * 0.45) score += 20;
        return { index, score };
      }).filter(Boolean).sort((a, b) => b.score - a.score);

      if (!visible.length || visible[0].score < 60) return null;
      const target = candidates[visible[0].index];
      const id = 'crawler-scratch-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
      target.setAttribute('data-crawler-scratch-id', id);
      target.scrollIntoView({ block: 'center', inline: 'center' });
      return { id, score: visible[0].score };
    });

    if (!probe) return { handled: false, advanced: false };
    console.log('Scratch/reveal interaction detected. Attempting a full-coverage scratch.');

    const beforeState = state || await inspectPage();
    const beforeSignature = pageSignature(beforeState);
    const beforeUrl = sanitizeUrl(page.url());

    if (currentNumberedCaptureSignature && beforeSignature !== currentNumberedCaptureSignature) {
      console.log('Scratch/reveal page appeared after the current numbered screenshot. Deferring interaction so its closed state is captured on the next numbered screen.');
      return { handled: true, advanced: true };
    }

    const target = page.locator('[data-crawler-scratch-id="' + probe.id + '"]');
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(180);

    let box = await target.boundingBox().catch(() => null);
    if (!box) return { handled: true, advanced: false };

    const beforeVisual = await target.screenshot().catch(() => null);

    const scratchPass = async pass => {
      box = await target.boundingBox().catch(() => box);
      if (!box) return;
      const left = box.x + box.width * 0.05;
      const right = box.x + box.width * 0.95;
      const top = box.y + box.height * 0.06;
      const bottom = box.y + box.height * 0.94;

      const rows = pass === 0 ? 14 : 18;
      for (let row = 0; row < rows; row++) {
        const y = top + ((bottom - top) * row / Math.max(rows - 1, 1));
        const startX = row % 2 === 0 ? left : right;
        const endX = row % 2 === 0 ? right : left;
        await page.mouse.move(startX, y);
        await page.mouse.down();
        await page.mouse.move(endX, y, { steps: 28 });
        await page.mouse.up();
      }

      const columns = pass === 0 ? 7 : 10;
      for (let col = 0; col < columns; col++) {
        const x = left + ((right - left) * col / Math.max(columns - 1, 1));
        const startY = col % 2 === 0 ? top : bottom;
        const endY = col % 2 === 0 ? bottom : top;
        await page.mouse.move(x, startY);
        await page.mouse.down();
        await page.mouse.move(x, endY, { steps: 24 });
        await page.mouse.up();
      }

      if (pass > 0) {
        await page.mouse.move(left, top);
        await page.mouse.down();
        await page.mouse.move(right, bottom, { steps: 30 });
        await page.mouse.up();
        await page.mouse.move(right, top);
        await page.mouse.down();
        await page.mouse.move(left, bottom, { steps: 30 });
        await page.mouse.up();
      }
    };

    const clickScratchCompletionCTA = async () => {
      const id = await page.evaluate(() => {
        const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
        const positive = /^(?:continue|next|see|show|view|get|claim|unlock|reveal|open)(?:\s+.{0,55})?$/i;
        const visible = el => {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
            r.top < window.innerHeight && r.left < window.innerWidth &&
            st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0 &&
            st.pointerEvents !== 'none';
        };
        const candidates = [];
        for (const el of Array.from(document.querySelectorAll('button, a, [role="button"], [onclick], [tabindex]'))) {
          if (!visible(el)) continue;
          const text = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
          if (!positive.test(text)) continue;
          if (/\b(back|previous|close|dismiss|no thanks|not now|buy|purchase|pay)\b/i.test(text)) continue;
          const r = el.getBoundingClientRect();
          candidates.push({ el, top: r.top, area: r.width * r.height, text });
        }
        candidates.sort((a, b) => b.top - a.top || b.area - a.area);
        if (!candidates.length) return null;
        const chosen = candidates[0];
        const id = 'crawler-scratch-complete-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
        chosen.el.setAttribute('data-crawler-scratch-complete-id', id);
        chosen.el.scrollIntoView({ block: 'center', inline: 'center' });
        return { id, text: chosen.text };
      }).catch(() => null);
      if (!id || !id.id) return false;
      console.log('Post-scratch CTA detected:', id.text || '(no text)');
      return await safeCrawlerClick(
        page.locator('[data-crawler-scratch-complete-id="' + id.id + '"]'),
        id.text || 'post-scratch CTA'
      );
    };

    let visualChanged = false;
    let scratchRevealWaitCompleted = false;
    const waitAfterConfirmedScratch = async () => {
      if (!visualChanged || scratchRevealWaitCompleted) return;
      scratchRevealWaitCompleted = true;
      console.log('Scratch surface visibly changed. Waiting 4 seconds for delayed reveal/Continue CTA.');
      await page.waitForTimeout(4000);
    };
    let afterState = beforeState;

    try {
      for (let pass = 0; pass < 3; pass++) {
        console.log('Scratch coverage pass ' + (pass + 1) + '/3.');
        await scratchPass(pass);
        await page.waitForTimeout(550);

        const currentVisual = await target.screenshot().catch(() => null);
        if (beforeVisual && currentVisual && !beforeVisual.equals(currentVisual)) visualChanged = true;
        await waitAfterConfirmedScratch();

        afterState = await inspectPageNavigationSafe('post-scratch inspection').catch(() => beforeState);
        const signatureChanged = pageSignature(afterState) !== beforeSignature;
        const urlChanged = sanitizeUrl(page.url()) !== beforeUrl;
        const paywallState = await inspectPaywallState().catch(() => ({ isPagePaywall: false }));

        if (signatureChanged || urlChanged || paywallState.isPagePaywall) break;

        const ctaClicked = await clickScratchCompletionCTA();
        if (ctaClicked) {
          if (await waitForAdvancement(beforeSignature, 10000)) {
            afterState = await inspectPageNavigationSafe('post-scratch CTA landing').catch(() => afterState);
            break;
          }
        }
      }
    } catch (error) {
      console.log('Scratch gesture failed:', String(error && error.message || error).split('\n')[0]);
      return { handled: true, advanced: false };
    }

    await page.evaluate(() => {
      const selection = window.getSelection && window.getSelection();
      if (selection) selection.removeAllRanges();
      const active = document.activeElement;
      if (active && typeof active.blur === 'function') active.blur();
    }).catch(() => {});

    await page.waitForTimeout(300);
    afterState = await inspectPageNavigationSafe('final scratch inspection').catch(() => afterState);
    let changed = pageSignature(afterState) !== beforeSignature || sanitizeUrl(page.url()) !== beforeUrl;
    let paywallState = await inspectPaywallState().catch(() => ({ isPagePaywall: false }));

    if (screenNumber !== null && (changed || visualChanged || paywallState.isPagePaywall)) {
      const revealFilename = path.join(OUTPUT_DIR, String(screenNumber).padStart(2, '0') + 'b.png');
      await page.screenshot({ path: revealFilename, fullPage: true });
      console.log('Captured scratch/reveal completed: ' + revealFilename);
      supplementalCounterByScreen.set(
        screenNumber,
        Math.max(supplementalCounterByScreen.get(screenNumber) || 0, 2)
      );
    }

    if (changed || paywallState.isPagePaywall) return { handled: true, advanced: true };

    const navigationResult = await clickStrongNavigation(afterState, 'post-scratch navigation CTA');
    if (navigationResult.handled) return navigationResult;

    const completionClicked = await clickScratchCompletionCTA();
    if (completionClicked && await waitForAdvancement(beforeSignature, 12000)) {
      return { handled: true, advanced: true };
    }

    if (visualChanged && box) {
      console.log('Scratch surface changed but no CTA/navigation was detected. Trying one center tap on the revealed card.');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
      if (await waitForAdvancement(beforeSignature, 8000)) {
        return { handled: true, advanced: true };
      }
    }

    console.log(
      visualChanged
        ? 'Scratch surface was visibly altered, but the funnel still did not expose a safe route to the next page.'
        : 'Scratch surface did not visibly change after full-coverage gestures.'
    );
    return { handled: true, advanced: false };
  }

  async function handleEnglishLanguageChoice() {
    const result = await page.evaluate(() => {
      const languageNames = [
        'english', 'ukrainian', 'українська', 'український', 'spanish', 'español', 'french', 'français',
        'german', 'deutsch', 'italian', 'italiano', 'portuguese', 'português', 'turkish', 'türkçe',
        'polish', 'polski', 'russian', 'русский', 'arabic', 'العربية', 'japanese', '日本語',
        'korean', '한국어', 'chinese', '中文', 'dutch', 'nederlands', 'swedish', 'svenska',
        'norwegian', 'norsk', 'danish', 'dansk', 'finnish', 'suomi', 'czech', 'čeština',
        'romanian', 'română', 'hungarian', 'magyar', 'greek', 'ελληνικά'
      ];
      const normalize = value => (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
          rect.top < window.innerHeight && rect.left < window.innerWidth &&
          style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      };
      const reachable = el => {
        if (!visible(el)) return false;
        const rect = el.getBoundingClientRect();
        const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
        const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
        const top = document.elementFromPoint(x, y);
        return !!top && (top === el || el.contains(top) || top.contains(el));
      };
      const languageForText = text => languageNames.find(name =>
        text === name || text.startsWith(name + ' ') || text.startsWith(name + '|') ||
        text.startsWith(name + '/') || text.startsWith(name + '(')
      ) || null;
      const cardForLabel = (labelEl, root) => {
        let el = labelEl;
        let depth = 0;
        let fallback = null;
        while (el && el !== document.body && depth < 7) {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role');
          const substantial = rect.width >= 55 && rect.height >= 28 && rect.width <= window.innerWidth * 0.98;
          const explicit = tag === 'button' || tag === 'a' || tag === 'label' || tag === 'li' ||
            role === 'button' || role === 'radio' || role === 'option' || role === 'menuitem' ||
            el.hasAttribute('onclick') || el.tabIndex >= 0 || style.cursor === 'pointer';
          const bordered = parseFloat(style.borderTopWidth || '0') > 0 || parseFloat(style.borderRightWidth || '0') > 0 ||
            parseFloat(style.borderBottomWidth || '0') > 0 || parseFloat(style.borderLeftWidth || '0') > 0;
          if (substantial && explicit && reachable(el)) return el;
          if (substantial && bordered && reachable(el) && !fallback) fallback = el;
          if (el === root) break;
          el = el.parentElement;
          depth++;
        }
        if (reachable(labelEl)) return labelEl;
        return fallback;
      };

      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
      const roots = dialogs.length ? dialogs : [document.body];
      const candidates = [];
      for (const root of roots) {
        const all = [root, ...Array.from(root.querySelectorAll('*'))];
        for (const el of all) {
          if (!visible(el)) continue;
          const text = normalize(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '');
          if (!text || text.length > 100) continue;
          const language = languageForText(text);
          if (!language) continue;
          const card = cardForLabel(el, root);
          if (!card || !reachable(card)) continue;
          const rect = card.getBoundingClientRect();
          candidates.push({ language, text, card, area: rect.width * rect.height, inDialog: dialogs.includes(root) });
        }
      }

      const unique = [];
      const seen = new Set();
      for (const item of candidates) {
        if (seen.has(item.card)) continue;
        seen.add(item.card);
        unique.push(item);
      }
      const distinctLanguages = new Set(unique.map(x => x.language));
      const english = unique.filter(x => x.language === 'english').sort((a, b) =>
        Number(b.inDialog) - Number(a.inDialog) || a.area - b.area
      );
      if (distinctLanguages.size < 2 || !english.length) return null;
      const chosen = english[0];
      const id = `language-choice-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
      chosen.card.setAttribute('data-language-choice-id', id);
      return { id, text: chosen.text, languages: Array.from(distinctLanguages).slice(0, 12), inDialog: chosen.inDialog };
    });

    if (!result) return false;
    console.log('Language-choice page detected. Preferring English. Languages found:', result.languages);
    if (result.inDialog) console.log('English option is inside the active modal/dialog.');

    const beforeState = await inspectPage();
    const beforeSignature = pageSignature(beforeState);
    const target = page.locator(`[data-language-choice-id="${result.id}"]`);
    const clicked = await safeCrawlerClick(target, 'English language option');
    if (!clicked) {
      console.log('English option was detected but is not safely reachable. Will not interact with controls behind the overlay.');
      return false;
    }

    // Radio/card selection pages often keep the exact same URL and visible text.
    // The only change is checked state + an enabled Next button, so pageSignature()
    // deliberately cannot be used as proof that the language step advanced.
    await page.waitForTimeout(500);

    // If selecting English auto-advanced, accept the real page change.
    if (await waitForAdvancement(beforeSignature, 1800)) {
      console.log('English language selected and the page auto-advanced.');
      return true;
    }

    const selected = await page.evaluate(() => {
      const marked = document.querySelector('[data-language-choice-id]');
      if (!marked) return false;
      const truthy = value => ['true', 'checked', 'selected', 'on'].includes(String(value || '').toLowerCase());
      if (marked.matches('input:checked')) return true;
      if (truthy(marked.getAttribute('aria-checked')) || truthy(marked.getAttribute('aria-selected')) || truthy(marked.getAttribute('data-state'))) return true;
      if (marked.querySelector('input:checked, [aria-checked="true"], [aria-selected="true"], [data-state="checked"], [data-state="selected"]')) return true;

      let ancestor = marked.parentElement;
      for (let depth = 0; ancestor && ancestor !== document.body && depth < 5; depth++, ancestor = ancestor.parentElement) {
        if (ancestor.matches('input:checked')) return true;
        if (truthy(ancestor.getAttribute('aria-checked')) || truthy(ancestor.getAttribute('aria-selected')) || truthy(ancestor.getAttribute('data-state'))) return true;
        if (ancestor.querySelector('input:checked, [aria-checked="true"], [aria-selected="true"], [data-state="checked"], [data-state="selected"]')) return true;
      }
      return false;
    }).catch(() => false);

    if (selected) console.log('English language selected. Looking for the now-enabled navigation button.');

    // EWA-style language screens enable a bottom Next button only after a radio
    // choice is selected. Use the dedicated bottom-navigation finder and WAIT for
    // advancement; returning immediately after click races the outer loop and made
    // it think the crawler was still on the same page.
    let afterState = await inspectPageNavigationSafe('language-choice post-selection inspection');
    let navigationTarget = await findBottomNavigationFallback();

    if (!navigationTarget && afterState.cta && isStrongNavigationText(afterState.cta.text || '')) {
      navigationTarget = {
        id: afterState.cta.id,
        text: afterState.cta.text || 'language-choice CTA',
        autoId: true
      };
    }

    if (navigationTarget) {
      const navBefore = pageSignature(afterState);
      const locator = navigationTarget.autoId
        ? page.locator(`[data-auto-id="${navigationTarget.id}"]`)
        : page.locator(`[data-bottom-navigation-id="${navigationTarget.id}"]`);
      const ctaClicked = await safeCrawlerClick(
        locator,
        navigationTarget.text || 'language-choice CTA'
      );
      if (!ctaClicked) return false;

      const advanced = await waitForAdvancement(navBefore, 12000);
      if (advanced) {
        console.log('English language selected and navigation completed.');
        return true;
      }

      console.log('English was selected and Next was clicked, but the page did not advance.');
      return false;
    }

    // Give SPAs one more short window in case the selected state triggers delayed
    // navigation without a conventional button.
    if (await waitForAdvancement(beforeSignature, 3500)) {
      console.log('English language selected and delayed navigation completed.');
      return true;
    }

    console.log('English language was selected, but no enabled Next/Continue control was found.');
    return false;
  }

  async function inspectPaywallState() {
    return await page.evaluate(() => {
      const normalize = value => (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const bodyText = normalize(document.body.innerText || '');
      const currencyPattern = /(?:[$€£¥₺₹₽₴₩]|\b(?:usd|eur|gbp|cad|aud|nzd|try|jpy|cny|inr|uah|rub|krw)\b)\s*\d|\d[\d.,\s]*\s*(?:[$€£¥₺₹₽₴₩]|\b(?:usd|eur|gbp|cad|aud|nzd|try|jpy|cny|inr|uah|rub|krw)\b)/i;
      const elements = Array.from(document.querySelectorAll('body *'));
      const prices = [];
      for (const el of elements) {
        if (el.children.length > 3) continue;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
          style.visibility !== 'hidden' && Number(style.opacity) > 0;
        if (!visible) continue;
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160);
        if (!text || !currencyPattern.test(text)) continue;
        const crossed = el.tagName.toLowerCase() === 'del' || el.tagName.toLowerCase() === 's' ||
          style.textDecorationLine.includes('line-through') || style.textDecoration.includes('line-through');
        const modalAncestor = el.closest(
          '[role="dialog"], [aria-modal="true"], .modal, [class*="modal"], [class*="popup"], [class*="dialog"]'
        );
        prices.push({ text, crossed, inModal: !!modalAncestor });
      }
      const unique = [];
      const seen = new Set();
      for (const price of prices) {
        const key = `${price.text}|${price.crossed}|${price.inModal}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(price);
        }
      }
      const crossed = unique.filter(x => x.crossed);
      const current = unique.filter(x => !x.crossed);
      const hasDiscountPair = crossed.length > 0 && current.length > 0;
      const pairOnlyInModal = hasDiscountPair && crossed.every(x => x.inModal) && current.every(x => x.inModal);
      const documentHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const documentWidth = Math.max(document.body.scrollWidth, document.documentElement.scrollWidth);
      const longPage = documentHeight > window.innerHeight * 1.3;

      const readyPlanPattern = /\b(?:your|the)\s+(?:personal(?:ized|ised)?\s+)?(?:plan|program|programme|learning plan|improvement plan)\s+(?:is\s+)?(?:ready|complete|prepared|created|built)\b|\b(?:plan|program|programme)\s+(?:is\s+)?ready\b/i;
      const pricingPattern = /\b(?:pricing|price|subscription|subscribe|membership|billing|payment|trial|week(?:ly)?|month(?:ly)?|year(?:ly)?|annual|lifetime|most popular|discount|off|unlock|unlimited access|choose (?:your|a) plan|select (?:your|a) plan)\b/i;
      const purchasePattern = /\b(?:buy|purchase|subscribe|start (?:my |your )?(?:trial|plan)|claim (?:offer|discount)|unlock (?:my |your )?(?:plan|access|results?)|get (?:my |your )?(?:plan|access)|continue to payment)\b/i;
      const hasPlanReadyLanguage = readyPlanPattern.test(bodyText);
      const hasPricingLanguage = pricingPattern.test(bodyText);
      const hasPurchaseLanguage = purchasePattern.test(bodyText);
      const hasMultiplePrices = current.length >= 2;

      // Email-delivery gates often say things like "Your plan is ready to send",
      // "weekly progress reports", and "GET MY PLAN". Those phrases used to
      // satisfy the broad plan-ready + pricing heuristic even though the user still
      // has to enter an email before the real pricing/paywall screen appears.
      // A visible editable email field therefore suppresses the weak paywall rule
      // unless genuine price/currency evidence is already present.
      const visibleEmailField = Array.from(document.querySelectorAll('input, textarea')).some(el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
        if (!visible || el.disabled) return false;
        const signals = [
          el.getAttribute('type'), el.getAttribute('name'), el.getAttribute('placeholder'),
          el.getAttribute('autocomplete'), el.getAttribute('aria-label')
        ].filter(Boolean).join(' ').toLowerCase();
        return el.getAttribute('type') === 'email' || /\be-?mail\b/.test(signals);
      });
      const hasRealPriceEvidence = current.length >= 1 || crossed.length >= 1;
      const hasPlanPricingPaywall = hasPlanReadyLanguage && hasPricingLanguage &&
        (hasRealPriceEvidence || hasPurchaseLanguage) &&
        !(visibleEmailField && !hasRealPriceEvidence);
      const hasStrongPricingPaywall = hasPricingLanguage && hasMultiplePrices && (hasPurchaseLanguage || longPage);
      const discountPaywall = hasDiscountPair && !pairOnlyInModal && longPage;
      const isPagePaywall = discountPaywall || hasPlanPricingPaywall || hasStrongPricingPaywall;
      let reason = null;
      if (discountPaywall) reason = 'discounted price structure';
      else if (hasPlanPricingPaywall) reason = 'plan-ready + pricing/subscription context';
      else if (hasStrongPricingPaywall) reason = 'strong pricing/subscription structure';

      return {
        hasDiscountPair, pairOnlyInModal, longPage, documentHeight, documentWidth,
        crossedPrices: crossed.map(x => x.text).slice(0, 5),
        currentPrices: current.map(x => x.text).slice(0, 8),
        hasPlanReadyLanguage, hasPricingLanguage, hasPurchaseLanguage,
        isPagePaywall, reason
      };
    });
  }

  async function inspectPage() {
    return await page.evaluate(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      window.__crawlerAutoCounter = window.__crawlerAutoCounter || 0;
      const all = Array.from(document.querySelectorAll('*'));
      const pageText = document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 3000);
      const questionSignals = /\b(select all that apply|choose all that apply|select any|choose any|select one|choose one|pick one|choose\s+\d+|select\s+\d+|pick\s+\d+|or more|at least|which|what(?:'s| is| are| do| would)|how (?:often|do|would|well|much))\b/i;
      const navigationText = /^(continue|next|proceed|submit|done|finish|start|see results?|get started|create account|sign up|go on|keep going|move on|let(?:'|’)s continue|let(?:'|’)s go|devam|devam et|ileri)$/i;
      const mediaOnlyText = /^(play|pause|listen|listen again|replay|audio|sound|hear|speaker)$/i;

      const controls = all.map((el, index) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role');
        const inputType = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : null;
        const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
          rect.top < vh && rect.left < vw && style.display !== 'none' &&
          style.visibility !== 'hidden' && Number(style.opacity) > 0;
        const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true' || style.pointerEvents === 'none';
        const editableField = tag === 'textarea' ||
          (tag === 'input' && ['text', 'email', 'search', 'tel', 'url', 'password', 'number'].includes(inputType));
        const answerControl = role === 'radio' || role === 'checkbox' ||
          (tag === 'input' && ['radio', 'checkbox'].includes(inputType));
        const navigationControl = tag === 'button' || tag === 'a' || role === 'button' ||
          (tag === 'input' && ['button', 'submit'].includes(inputType));
        const genericClickable = !editableField &&
          (tag === 'label' || el.hasAttribute('onclick') || el.tabIndex >= 0 || style.cursor === 'pointer');
        const interactive = answerControl || navigationControl || genericClickable;
        if (!visible || disabled || !interactive || editableField) return null;
        const text = (
          el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || ''
        ).trim().replace(/\s+/g, ' ').slice(0, 100);
        const aria = (el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 100);
        if (/^cookie(?:s)?(?: settings| preferences| policy)?$/i.test(text) ||
            /^cookie(?:s)?(?: settings| preferences| policy)?$/i.test(aria)) return null;
        const mediaElement = tag === 'audio' || tag === 'video';
        const explicitMediaControl = mediaElement || mediaOnlyText.test(text) || mediaOnlyText.test(aria);
        if (explicitMediaControl && !answerControl) return null;
        let id = el.getAttribute('data-auto-id');
        if (!id) {
          window.__crawlerAutoCounter += 1;
          id = `crawler-auto-${window.__crawlerAutoCounter}`;
          el.setAttribute('data-auto-id', id);
        }
        return {
          id,
          parentId: el.parentElement ? all.indexOf(el.parentElement) : null,
          text, tag, role, inputType, answerControl, navigationControl,
          width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom, left: rect.left
        };
      }).filter(Boolean);

      const groups = new Map();
      for (const item of controls) {
        if (item.parentId === null) continue;
        if (!groups.has(item.parentId)) groups.set(item.parentId, []);
        groups.get(item.parentId).push(item);
      }

      const spatialCandidates = controls.filter(item =>
        item.text.length > 0 && item.text.length <= 100 &&
        !navigationText.test(item.text.trim()) &&
        item.width >= vw * 0.20 && item.width <= vw * 0.98 &&
        item.height >= 34 && item.height <= 180 &&
        item.top >= vh * 0.12 && item.bottom <= vh * 0.90
      );

      if (spatialCandidates.length >= 3) {
        const buckets = [];
        for (const item of spatialCandidates) {
          let bucket = buckets.find(group => {
            const ref = group[0];
            return Math.abs(item.width - ref.width) <= Math.max(ref.width * 0.20, 24) &&
              Math.abs(item.height - ref.height) <= Math.max(ref.height * 0.30, 20);
          });
          if (!bucket) {
            bucket = [];
            buckets.push(bucket);
          }
          bucket.push(item);
        }

        for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) {
          const bucket = buckets[bucketIndex];
          if (bucket.length < 3 || bucket.length > 24) continue;
          const rows = [];
          const cols = [];
          for (const item of bucket) {
            if (!rows.some(v => Math.abs(v - item.top) <= Math.max(item.height * 0.45, 24))) rows.push(item.top);
            if (!cols.some(v => Math.abs(v - item.left) <= Math.max(item.width * 0.35, 26))) cols.push(item.left);
          }
          const repeatedLayout = rows.length >= 2 || cols.length >= 2;
          if (!repeatedLayout) continue;
          groups.set(`spatial-${bucketIndex}`, bucket);
        }
      }

      let bestGroup = null;
      for (const items of groups.values()) {
        if (items.length < 2 || items.length > 24) continue;
        const avgWidth = items.reduce((sum, x) => sum + x.width, 0) / items.length;
        const avgHeight = items.reduce((sum, x) => sum + x.height, 0) / items.length;
        const similarSizes = items.every(item =>
          Math.abs(item.width - avgWidth) <= Math.max(avgWidth * 0.4, 20) &&
          Math.abs(item.height - avgHeight) <= Math.max(avgHeight * 0.4, 15)
        );
        if (!similarSizes || avgWidth < 30 || avgHeight < 25) continue;
        const groupBottom = Math.max(...items.map(item => item.bottom));
        if (groupBottom < vh * 0.2) continue;
        let score = 50 + Math.min(items.length * 5, 45);
        if (items.some(item => item.answerControl)) score += 20;
        const widthSimilarity = Math.max(...items.map(item => item.width)) - Math.min(...items.map(item => item.width));
        const heightSimilarity = Math.max(...items.map(item => item.height)) - Math.min(...items.map(item => item.height));
        if (widthSimilarity <= Math.max(avgWidth * 0.2, 12) &&
            heightSimilarity <= Math.max(avgHeight * 0.2, 10)) score += 15;
        if (items.length >= 3) score += 20;
        if (items.length >= 3 && questionSignals.test(pageText)) score += 45;
        if (items.every(item => !navigationText.test(item.text.trim()))) score += 15;
        if (!bestGroup || score > bestGroup.score) bestGroup = { score, items };
      }

      const answerIds = new Set(bestGroup ? bestGroup.items.map(item => item.id) : []);
      let bestCTA = null;
      const nonNavigationLinkText = /^(?:privacy(?: policy)?|terms(?: & conditions)?|terms and conditions|conditions of use|subscription policy|money-back(?: guarantee)?|docs?|faq|help|support|legal|cookie(?: policy)?)$/i;
      for (const item of controls) {
        if (item.answerControl || answerIds.has(item.id)) continue;
        if (nonNavigationLinkText.test((item.text || '').trim())) continue;
        let score = 0;
        const centerY = item.top + item.height / 2;
        const widthRatio = item.width / vw;
        if (centerY > vh * 0.82) score += 90;
        else if (centerY > vh * 0.68) score += 65;
        else if (centerY > vh * 0.5) score += 25;
        else score -= 15;
        if (widthRatio >= 0.75) score += 30;
        else if (widthRatio >= 0.5) score += 20;
        if (item.height >= 40 && item.height <= 100) score += 20;
        if (item.navigationControl) score += 20;
        if (navigationText.test(item.text.trim())) score += 60;
        if (item.text.length > 0 && item.text.length <= 50) score += 10;
        if (item.inputType === 'submit' || item.inputType === 'button') score += 20;
        if (item.width < 80 || item.height < 25) score -= 50;
        if (item.tag === 'a' && (item.width < vw * 0.5 || item.height < 36)) score -= 45;
        if (!bestCTA || score > bestCTA.score) bestCTA = { ...item, score };
      }

      return {
        pageText,
        cta: bestCTA && bestCTA.score >= 50 ? bestCTA : null,
        group: bestGroup ? bestGroup.items : []
      };
    });
  }

  function pageSignature(state) {
    return `${sanitizeUrl(page.url())}\n${state.pageText}`;
  }

  async function findBottomNavigationFallback() {
    return await page.evaluate(() => {
      const pattern = /^(continue|next|proceed|submit|done|finish|start|see results?|get started|create account|sign up|go on|keep going|move on|let(?:'|’)s continue|let(?:'|’)s go|devam|devam et|ileri)$/i;
      const all = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"], [onclick], [tabindex]'));
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const candidates = [];
      for (const el of all) {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ');
        const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
        const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true' || style.pointerEvents === 'none';
        if (!visible || disabled || !pattern.test(text)) continue;
        const centerY = rect.top + rect.height / 2;
        const widthRatio = rect.width / vw;
        let score = 0;
        if (centerY > vh * 0.78) score += 120;
        else if (centerY > vh * 0.62) score += 70;
        if (widthRatio >= 0.72) score += 55;
        else if (widthRatio >= 0.45) score += 30;
        if (rect.height >= 38 && rect.height <= 110) score += 25;
        if (el.tagName.toLowerCase() === 'button' || el.getAttribute('role') === 'button') score += 20;
        candidates.push({ el, text, score });
      }
      if (!candidates.length) return null;
      candidates.sort((a, b) => b.score - a.score);
      const chosen = candidates[0];
      const id = `bottom-navigation-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
      chosen.el.setAttribute('data-bottom-navigation-id', id);
      return { id, text: chosen.text, score: chosen.score };
    });
  }

  async function clickStrongNavigation(state, description = 'primary navigation CTA') {
    const consentState = await handleRequiredPageConsentCheckboxes();
    if (consentState.found && !consentState.active) {
      console.log('Required consent could not be activated. Navigation will not be attempted.');
      return { handled: true, advanced: false };
    }
    if (consentState.changed) {
      await page.waitForTimeout(350);
      state = await inspectPageNavigationSafe('post-consent navigation inspection');
    }

    const hasStrongCTA = state?.cta && isStrongNavigationText(state.cta.text);
    const fallback = await findBottomNavigationFallback();
    if (!hasStrongCTA && !fallback) return { handled: false, advanced: false };

    const target = fallback;
    if (!target) return { handled: false, advanced: false };
    console.log(hasStrongCTA ? 'Strong navigation CTA detected:' : 'Bottom primary navigation fallback detected:', target.text);

    const beforeState = await inspectPage();
    const before = pageSignature(beforeState);
    const clicked = await safeCrawlerClick(
      page.locator(`[data-bottom-navigation-id="${target.id}"]`),
      target.text || description
    );
    if (!clicked) return { handled: true, advanced: false };

    const advanced = await waitForAdvancement(before, 12000);
    if (!advanced) console.log('Navigation CTA was clicked, but no meaningful page advancement was detected.');
    return { handled: true, advanced };
  }

  async function captureSupplementalState(screenNumber, state, reason, removeTexts = [], threshold = 0.95) {
    const fingerprint = normalizeContextText(state?.pageText || '', removeTexts);
    if (!fingerprint || fingerprint.length < 10) return null;
    if (supplementalFingerprintSeen(screenNumber, fingerprint, threshold)) {
      console.log(`Supplemental state is contextually the same as one already captured. Skipping duplicate (${reason}).`);
      return null;
    }
    const filename = nextSupplementalFilename(screenNumber);
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`Captured supplemental state (${reason}): ${filename}`);
    return filename;
  }

  async function waitForScreenshotReady({ minimumWaitMs = 2200, maxWaitMs = 5500, pollMs = 300 } = {}) {
    await page.waitForTimeout(minimumWaitMs);
    await dismissBlockingConsentOverlay();
    let previous = null;
    let stableCount = 0;
    const startedAt = Date.now();
    while (Date.now() - startedAt < Math.max(0, maxWaitMs - minimumWaitMs)) {
      await silenceMedia();
      const snapshot = await page.evaluate(() => {
        const runningFiniteAnimations = document.getAnimations
          ? document.getAnimations().filter(animation => {
              if (animation.playState !== 'running') return false;
              const timing = animation.effect?.getComputedTiming?.();
              if (!timing) return true;
              return Number.isFinite(timing.endTime) && timing.endTime <= 6000;
            }).length
          : 0;
        return {
          text: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 2500),
          height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
          runningFiniteAnimations
        };
      });
      if (previous && snapshot.text === previous.text && snapshot.height === previous.height && snapshot.runningFiniteAnimations === 0) {
        stableCount++;
        if (stableCount >= 2) return;
      } else {
        stableCount = 0;
      }
      previous = snapshot;
      await page.waitForTimeout(pollMs);
    }
  }

  async function hasVisibleEditableInput() {
    // This helper is used by passive-transition waiting, so it must include
    // numeric profile fields too. BetterMe weight/height steps commonly use
    // type="number" or numeric/decimal inputmode and can appear before any CTA.
    const fields = page.locator(
      'input:not([type]), input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="tel"], input[type="url"], input[type="number"], input[inputmode="numeric"], input[inputmode="decimal"], textarea'
    );
    const count = await fields.count();
    for (let i = 0; i < count; i++) {
      const field = fields.nth(i);
      if (!(await field.isVisible().catch(() => false))) continue;
      if (!(await field.isEnabled().catch(() => false))) continue;
      if (!(await field.isEditable().catch(() => false))) continue;
      return true;
    }
    return false;
  }

  async function handleSkippableInputRequirement(state) {
    if (!isSpeechInputScreen(state.pageText) && !hasSkipEscapeChoice(state)) return false;
    const result = await page.evaluate(() => {
      const escapePattern = /^(skip|skip for now|not now|maybe later|later|do this later|do it later|continue without(?: this)?|continue without speaking|no thanks|no, thanks|i'll do this later|i will do this later)$/i;
      const elements = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"], [onclick], [tabindex]'));
      const candidates = [];
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
          rect.top < window.innerHeight && rect.left < window.innerWidth &&
          style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
        if (!visible) continue;
        const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ');
        const explicitEscape = escapePattern.test(text);
        const topRightIconEscape = !text &&
          rect.top <= Math.max(140, window.innerHeight * 0.18) &&
          (window.innerWidth - rect.right) <= Math.max(105, window.innerWidth * 0.24) &&
          rect.width <= 110 && rect.height <= 110 &&
          !!el.querySelector('svg, img');
        if (!explicitEscape && !topRightIconEscape) continue;

        const cx = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
        const cy = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
        const top = document.elementFromPoint(cx, cy);
        const reachable = !!top && (top === el || el.contains(top) || top.contains(el));
        if (!reachable) continue;

        candidates.push({
          el,
          text: text || '[top-right icon escape]',
          explicitEscape,
          topRightIconEscape,
          area: rect.width * rect.height,
          top: rect.top,
          right: window.innerWidth - rect.right
        });
      }
      if (!candidates.length) return null;
      candidates.sort((a, b) => {
        if (a.explicitEscape !== b.explicitEscape) return a.explicitEscape ? -1 : 1;
        const aCorner = (a.top < window.innerHeight * 0.25 ? 1 : 0) + (a.right < window.innerWidth * 0.25 ? 1 : 0);
        const bCorner = (b.top < window.innerHeight * 0.25 ? 1 : 0) + (b.right < window.innerWidth * 0.25 ? 1 : 0);
        return bCorner - aCorner || a.area - b.area;
      });
      const chosen = candidates[0];
      const id = `skip-input-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
      chosen.el.setAttribute('data-skip-input-id', id);
      return { id, text: chosen.text };
    });

    if (!result) {
      if (isSpeechInputScreen(state.pageText)) console.log('Optional input/assessment screen detected, but no safe skip option was found.');
      return false;
    }

    console.log('Optional input/assessment requirement detected. Using escape option:', result.text);
    const before = pageSignature(state);
    const clicked = await safeCrawlerClick(page.locator(`[data-skip-input-id="${result.id}"]`), result.text || 'skip input');
    if (!clicked) return false;
    return await waitForAdvancement(before, 12000);
  }

  async function handleCustomNativeLanguage(state) {
    if (!isNativeLanguageQuestion(state.pageText)) return false;
    const textInputs = page.locator('input:not([type]), input[type="text"], input[type="search"]');
    const inputCount = await textInputs.count();
    for (let i = 0; i < inputCount; i++) {
      const input = textInputs.nth(i);
      if (!(await input.isVisible().catch(() => false)) || !(await input.isEnabled().catch(() => false))) continue;
      const inputReachable = await input.evaluate(el => {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
        const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
        const top = document.elementFromPoint(x, y);
        return !!top && (top === el || el.contains(top) || top.contains(el));
      }).catch(() => false);
      if (!inputReachable) {
        console.log('Ignoring native-language search input because it is covered by an active overlay.');
        continue;
      }

      console.log('Native-language text input detected.');
      for (const preferredLanguage of ['English', 'Spanish']) {
        const focused = await safeCrawlerClick(input, 'native-language search input');
        if (!focused) continue;
        try {
          await input.fill('');
          await input.fill(preferredLanguage);
        } catch {
          continue;
        }
        await page.waitForTimeout(500);

        const option = await page.evaluate((wantedLanguage) => {
          const wanted = wantedLanguage.toLowerCase();
          const visible = el => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
              rect.top < window.innerHeight && rect.left < window.innerWidth &&
              style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
          };
          const reachable = el => {
            if (!visible(el)) return false;
            const rect = el.getBoundingClientRect();
            const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
            const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
            const top = document.elementFromPoint(x, y);
            return !!top && (top === el || el.contains(top) || top.contains(el));
          };
          const all = Array.from(document.querySelectorAll('body *'));
          const matches = [];
          for (const el of all) {
            if (!visible(el)) continue;
            const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
            if (text.toLowerCase() !== wanted) continue;
            const clickable = el.closest('button, [role="option"], [role="menuitem"], [role="button"], a, li, [tabindex]') || el;
            if (!reachable(clickable)) continue;
            const rect = clickable.getBoundingClientRect();
            const dialog = clickable.closest('[role="dialog"], [aria-modal="true"]');
            matches.push({ el: clickable, area: rect.width * rect.height, inDialog: !!dialog });
          }
          if (!matches.length) return null;
          matches.sort((a, b) => Number(b.inDialog) - Number(a.inDialog) || a.area - b.area);
          const chosen = matches[0];
          const id = `native-language-option-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
          chosen.el.setAttribute('data-native-language-option-id', id);
          return { id };
        }, preferredLanguage);

        if (!option) continue;
        const clicked = await safeCrawlerClick(
          page.locator(`[data-native-language-option-id="${option.id}"]`),
          `native-language option ${preferredLanguage}`
        );
        if (!clicked) continue;
        console.log(`Selected preferred native language: ${preferredLanguage}`);
        await page.waitForTimeout(500);
        const afterSelection = await inspectPage();
        if (afterSelection.cta) {
          const beforeCTA = pageSignature(afterSelection);
          const ctaClicked = await safeCrawlerClick(page.locator(`[data-auto-id="${afterSelection.cta.id}"]`), afterSelection.cta.text || 'answer-group CTA');
          if (ctaClicked && await waitForAdvancement(beforeCTA, 10000)) return true;
          return false;
        }
        return true;
      }
    }
    return false;
  }

  function uniqueAnswerOptions(group) {
    const byKey = new Map();
    for (const item of (group || [])) {
      const key = ((item.text || '').trim().toLowerCase() || item.id);
      const area = Math.max(0, Number(item.width || 0) * Number(item.height || 0));
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { item, area });
        continue;
      }
      // Nested controls often repeat the same answer text. Prefer the larger
      // reachable card/container because that is usually the element whose click
      // actually advances card-based onboarding funnels.
      if (area > existing.area) byKey.set(key, { item, area });
    }
    return Array.from(byKey.values()).map(x => x.item);
  }

  async function clickAnswerCardFallback(optionText, beforeSignature) {
    const marker = await page.evaluate((wantedText) => {
      const wanted = (wantedText || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (!wanted) return null;
      const visible = el => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
          r.top < window.innerHeight && r.left < window.innerWidth &&
          st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0;
      };
      const reachable = el => {
        if (!visible(el)) return false;
        const r = el.getBoundingClientRect();
        const x = Math.max(0, Math.min(window.innerWidth - 1, r.left + r.width / 2));
        const y = Math.max(0, Math.min(window.innerHeight - 1, r.top + r.height / 2));
        const top = document.elementFromPoint(x, y);
        return !!top && (top === el || el.contains(top) || top.contains(el));
      };
      const all = Array.from(document.querySelectorAll('button, label, [role="button"], [role="radio"], [onclick], [tabindex]'));
      const candidates = [];
      for (const el of all) {
        if (!visible(el) || !reachable(el)) continue;
        const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '')
          .trim().toLowerCase().replace(/\s+/g, ' ');
        if (!text || !(text === wanted || text.includes(wanted))) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 80 || r.height < 30) continue;
        let score = r.width * r.height;
        if (el.tagName.toLowerCase() === 'label') score += 5000;
        if (el.getAttribute('role') === 'button' || el.tagName.toLowerCase() === 'button') score += 4000;
        candidates.push({ el, score });
      }
      if (!candidates.length) return null;
      candidates.sort((a, b) => b.score - a.score);
      const chosen = candidates[0].el;
      const id = `crawler-answer-card-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
      chosen.setAttribute('data-crawler-answer-card-id', id);
      return id;
    }, optionText).catch(() => null);

    if (!marker) return false;
    console.log('Answer did not advance from its nested control. Retrying the containing answer card:', optionText);
    const clicked = await safeCrawlerClick(
      page.locator(`[data-crawler-answer-card-id="${marker}"]`),
      `answer card ${optionText}`
    );
    if (!clicked) return false;
    return await waitForAdvancement(beforeSignature, 5000);
  }

  function isTransientPostSelectionShell(state) {
    if (!state) return true;
    const text = normalizeContextText(state.pageText || '');
    const hasMeaningfulText = text.length >= 35;
    const hasChoices = Array.isArray(state.group) && state.group.length > 0;
    const hasCTA = !!state.cta;
    return !hasMeaningfulText && !hasChoices && !hasCTA;
  }

  async function waitForPostSelectionSettle(label = 'post-selection state', minimumWaitMs = 2600, timeoutMs = 7000) {
    await page.waitForTimeout(minimumWaitMs);
    const startedAt = Date.now();
    let state = await inspectPageNavigationSafe(label);
    while (Date.now() - startedAt < timeoutMs && isTransientPostSelectionShell(state)) {
      console.log('Transient post-selection shell detected. Waiting for the real screen to mount.');
      await page.waitForTimeout(450);
      await silenceMedia();
      state = await inspectPageNavigationSafe(label);
    }
    return state;
  }

  async function handleAnswerGroup(state, screenNumber = null) {
    const initialSignature = pageSignature(state);
    const initialState = state;
    const initialUrl = sanitizeUrl(page.url());
    const instruction = getSelectionInstruction(state.pageText);
    const initialUniqueGroup = uniqueAnswerOptions(state.group);
    const availableAtStart = Math.max(initialUniqueGroup.length, 1);
    const minSelections = Math.max(1, Math.min(instruction.minSelections || 1, availableAtStart));
    const hardMax = instruction.maxSelections
      ? Math.min(instruction.maxSelections, availableAtStart)
      : Math.min(Math.max(minSelections + 3, 5), availableAtStart, 10);
    const selectedKeys = new Set();
    // A multi-select page may visually react after every checked answer. We only
    // need one screenshot proving that selected-state UI exists; subsequent
    // selections are interaction state, not separate funnel screens.
    let capturedSelectionVisual = false;

    console.log('Selection instruction detected:', {
      reason: instruction.reason,
      minSelections,
      maxSelections: instruction.maxSelections || 'until CTA becomes available'
    });

    for (let attempt = 0; attempt < hardMax; attempt++) {
      state = await inspectPage();
      if (!state.group.length) {
        const changed = pageSignature(state) !== initialSignature;
        return changed || selectedKeys.size >= minSelections;
      }

      const uniqueGroup = uniqueAnswerOptions(state.group);
      let option = null;
      if (isNativeLanguageQuestion(state.pageText)) {
        const preferred = choosePreferredNativeLanguage(uniqueGroup);
        if (preferred) {
          option = preferred.option;
          console.log(preferred.reason);
        }
      }

      if (!option) {
        option = uniqueGroup.find(candidate => {
          const key = candidate.id || (candidate.text || '').trim().toLowerCase();
          return !selectedKeys.has(key);
        });
      }

      if (!option) break;
      const optionKey = option.id || (option.text || '').trim().toLowerCase();
      console.log(`Selecting option ${selectedKeys.size + 1}:`, option.text || '[no visible text]');
      const clicked = await safeCrawlerClick(page.locator(`[data-auto-id="${option.id}"]`), option.text || 'answer option');
      if (!clicked) return false;
      selectedKeys.add(optionKey);

      // Give SPAs time to finish unmounting/mounting after a selection. A brief
      // blank shell is a transition between screens, not a meaningful visual state.
      let afterSelection = await waitForPostSelectionSettle('answer selection inspection', 2600, 7000);
      const samePageSelectionState = sanitizeUrl(page.url()) === initialUrl && afterSelection.group.length > 0;
      const contextChanged = normalizeContextText(afterSelection.pageText) !== normalizeContextText(initialState.pageText);
      const originalPrompt = questionPromptFingerprint(initialState);
      const currentPrompt = questionPromptFingerprint(afterSelection);
      const promptStillMatches = !!originalPrompt && !!currentPrompt && contextSimilarity(originalPrompt, currentPrompt) >= 0.86;
      const originalOptions = (initialState.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);
      const currentOptions = (afterSelection.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);
      const overlap = originalOptions.filter(text => currentOptions.includes(text)).length;
      const sameAnswerSet = overlap >= Math.max(1, Math.ceil(Math.min(originalOptions.length, currentOptions.length) * 0.6));
      if (samePageSelectionState && promptStillMatches && sameAnswerSet && !isTransientPostSelectionShell(afterSelection) && !capturedSelectionVisual) {
        const captured = await captureSamePageVisualVariant(screenNumber, `selection: ${option.text || '[no visible text]'}`);
        // Whether captureSamePageVisualVariant writes a file or deduplicates the
        // state, do not manufacture more screenshots merely because more boxes
        // are checked on this same question.
        capturedSelectionVisual = true;
      }

      // A lettered screenshot here is reserved for a genuine same-question
      // post-selection message/popup. A normal next question on the same URL must
      // remain a normal numbered page.
      if (screenNumber !== null && samePageSelectionState && contextChanged && promptStillMatches && sameAnswerSet && selectedKeys.size >= minSelections) {
        await captureSupplementalState(
          screenNumber,
          afterSelection,
          'post-selection response/popup',
          [option.text],
          0.95
        );
      }

      // A single-select page without an explicit Continue button commonly uses
      // the answer card itself as navigation. If clicking the answer moved us to a
      // genuinely different question/page, stop immediately instead of selecting a
      // second answer from the next screen.
      const afterSignature = pageSignature(afterSelection);
      const promptChanged = !!originalPrompt && !!currentPrompt && !promptStillMatches;
      const answerSetChanged = !sameAnswerSet;
      if (afterSignature !== initialSignature && (promptChanged || answerSetChanged || !afterSelection.group.length)) {
        return true;
      }

      if (selectedKeys.size < minSelections) {
        console.log(`Instruction requires at least ${minSelections}; selected ${selectedKeys.size}. Continuing selections.`);
        continue;
      }

      if (afterSelection.cta) {
        const consentState = await handleRequiredPageConsentCheckboxes();
        if (consentState.found && !consentState.active) {
          console.log('Required consent could not be activated. Answer-group CTA will not be clicked.');
          return false;
        }
        if (consentState.changed) {
          await page.waitForTimeout(350);
          afterSelection = await inspectPageNavigationSafe('answer-group post-consent inspection');
        }

        console.log('Minimum selection requirement satisfied. Using CTA:', afterSelection.cta?.text || '(no text)');
        if (!afterSelection.cta) return false;
        const beforeCTA = pageSignature(afterSelection);
        const ctaClicked = await safeCrawlerClick(
          page.locator(`[data-auto-id="${afterSelection.cta.id}"]`),
          afterSelection.cta.text || 'answer-group CTA'
        );
        if (ctaClicked && await waitForAdvancement(beforeCTA, 10000)) return true;
      } else if (minSelections === 1 && (instruction.maxSelections === null || instruction.maxSelections === 1)) {
        // Single-select pages often use the answer card itself as navigation and
        // therefore have no separate Continue CTA. This applies whether the parser
        // expresses the single-select rule as maxSelections=null or maxSelections=1.
        // Retry the larger containing answer card once before giving up.
        const advancedByCard = await clickAnswerCardFallback(option.text || '', initialSignature);
        if (advancedByCard) return true;
        // If a disabled bottom CTA is present, this may actually be a gated
        // multi-action exercise. Keep trying distinct untouched controls rather
        // than stopping after one click. Normal single-select pages without a
        // gated CTA retain their previous stop behavior.
        const gatedCTA = await page.evaluate(() => Array.from(document.querySelectorAll('button, [role="button"]')).some(el => {
          const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          const style = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return /^(check|continue|next|done|submit)$/i.test(text) &&
            r.width > 0 && r.height > 0 && style.display !== 'none' &&
            (el.disabled || el.getAttribute('aria-disabled') === 'true' || style.pointerEvents === 'none');
        })).catch(() => false);
        if (gatedCTA && selectedKeys.size < hardMax) {
          console.log('Bottom CTA still locked. Trying another untouched answer control.');
          continue;
        }
        console.log('Single-select page has no explicit Continue CTA and neither the nested control nor the containing answer card advanced.');
        return false;
      }

      if (instruction.maxSelections && selectedKeys.size >= instruction.maxSelections) break;
    }

    let finalState = await inspectPage();
    if (selectedKeys.size >= minSelections && finalState.cta) {
      const consentState = await handleRequiredPageConsentCheckboxes();
      if (consentState.found && !consentState.active) {
        console.log('Required consent could not be activated. Final answer-group CTA will not be clicked.');
        return false;
      }
      if (consentState.changed) {
        await page.waitForTimeout(350);
        finalState = await inspectPageNavigationSafe('final answer-group post-consent inspection');
      }
      if (!finalState.cta) return false;

      const beforeCTA = pageSignature(finalState);
      const ctaClicked = await safeCrawlerClick(
        page.locator(`[data-auto-id="${finalState.cta.id}"]`),
        finalState.cta.text || 'answer-group CTA'
      );
      if (ctaClicked && await waitForAdvancement(beforeCTA, 10000)) return true;
    }

    return pageSignature(finalState) !== initialSignature;
  }

  async function waitForVisualSettle({ initialWaitMs = 2200, checkMs = 350, maxExtraWaitMs = 3500 } = {}) {
    await page.waitForTimeout(initialWaitMs);
    let previousSnapshot = null;
    let stableCount = 0;
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxExtraWaitMs) {
      await silenceMedia();
      const currentSnapshot = await page.evaluate(() => ({
        text: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 2200),
        height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
        runningFiniteAnimations: document.getAnimations
          ? document.getAnimations().filter(animation => {
              if (animation.playState !== 'running') return false;
              const timing = animation.effect?.getComputedTiming?.();
              return !timing || (Number.isFinite(timing.endTime) && timing.endTime <= 6000);
            }).length
          : 0
      }));
      if (
        previousSnapshot &&
        currentSnapshot.text === previousSnapshot.text &&
        currentSnapshot.height === previousSnapshot.height &&
        currentSnapshot.runningFiniteAnimations === 0
      ) {
        stableCount++;
        if (stableCount >= 2) return;
      } else {
        stableCount = 0;
      }
      previousSnapshot = currentSnapshot;
      await page.waitForTimeout(checkMs);
    }
  }

  async function waitForActionableState({ timeoutMs = 12000, pollMs = 500 } = {}) {
    const startedAt = Date.now();
    const initialState = await inspectPage();
    const initialSignature = pageSignature(initialState);
    const initialUrl = sanitizeUrl(page.url());
    // A page with a visible editable field is an ACTIVE FORM, never a passive
    // transition. This precedence is intentional: form intent outranks copy like
    // "Almost There", "preparing", or other generic shell text.
    const initialEditableInput = await hasVisibleEditableInput();
    const initialProfileIntent = await detectExplicitProfileIntent();
    const passiveTransition = !initialEditableInput && !initialProfileIntent && isPassiveTransitionScreen(initialState.pageText);
    const effectiveTimeoutMs = passiveTransition ? Math.max(timeoutMs, 60000) : timeoutMs;

    if (passiveTransition) {
      console.log('Passive transition screen detected. Waiting for automatic navigation or completion.');
      console.log(`Watching for up to ${effectiveTimeoutMs / 1000}s...`);
    } else {
      console.log(`No action available yet. Watching for up to ${effectiveTimeoutMs / 1000}s...`);
    }

    while (Date.now() - startedAt < effectiveTimeoutMs) {
      await page.waitForTimeout(pollMs);
      await silenceMedia();
      const state = await inspectPage();
      const signature = pageSignature(state);
      // Editable inputs are actionable even when inspectPage() reports no CTA/group.
      // Numeric profile steps (weight, height, age, goal weight) often render their
      // input first while the bottom CTA is still disabled, so waiting logic must
      // hand control back to the main loop as soon as that input appears.
      const visibleEditableInput = await hasVisibleEditableInput();
      const explicitProfileIntent = await detectExplicitProfileIntent();
      const actionable = !!explicitProfileIntent || visibleEditableInput || state.group.length > 0 || state.cta !== null || isNativeLanguageQuestion(state.pageText) || isSpeechInputScreen(state.pageText) || hasSkipEscapeChoice(state);

      if (actionable) {
        if (explicitProfileIntent) console.log(`Actionable profile page detected from visible context: ${explicitProfileIntent.type}.`);
        if (passiveTransition) console.log(visibleEditableInput ? 'Passive transition completed: editable form input appeared.' : 'Passive transition completed: actionable screen appeared.');
        return { state, changed: signature !== initialSignature || visibleEditableInput || !!explicitProfileIntent };
      }

      if (passiveTransition) {
        const urlChanged = sanitizeUrl(page.url()) !== initialUrl;
        const stillPassive = isPassiveTransitionScreen(state.pageText);
        if (urlChanged || !stillPassive) {
          console.log('Automatic page transition detected. Continuing crawl.');
          return { state, changed: true };
        }
        continue;
      }

      if (signature !== initialSignature) return { state, changed: true };
    }

    if (passiveTransition) {
      console.log(`Passive transition did not complete after ${effectiveTimeoutMs / 1000}s.`);
    } else {
      console.log(`Nothing actionable or transitional appeared after ${effectiveTimeoutMs / 1000}s.`);
    }
    return null;
  }

  async function waitForAdvancement(beforeSignature, timeoutMs = 12000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await page.waitForTimeout(500);
      await silenceMedia();
      const currentState = await inspectPage();
      if (pageSignature(currentState) !== beforeSignature) return true;
    }
    return false;
  }

  async function handleRequiredPageConsentCheckboxes() {
    const pageInfo = await page.evaluate(() => {
      const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
      const bodyText = normalize(document.body?.innerText || '');
      const requiredPattern =
        /\bconsent\s+(?:is\s+)?required\s+to\s+continue\b|\brequired\s+consent\b|\bplease\s+(?:provide|give|accept)\s+(?:your\s+)?consent\b|\baccept\s+(?:the\s+)?(?:privacy\s+policy|terms?(?:\s+(?:and|&)?\s*conditions?)?)\s+to\s+continue\b|\bagree\s+(?:to\s+)?(?:the\s+)?(?:privacy\s+policy|terms?(?:\s+(?:and|&)?\s*conditions?)?)\s+to\s+continue\b|\bmust\s+(?:accept|agree|consent)\b/i;
      return {
        text: bodyText,
        explicitlyRequired: requiredPattern.test(bodyText)
      };
    }).catch(() => ({ text: '', explicitlyRequired: false }));

    const legalPattern = /\b(privacy|policy|terms?|conditions?|legal|agreement|processing|data|personal data|health data|onboarding data|information)\b/i;
    const acceptancePattern = /\b(i\s+)?(?:accept|agree|consent|authorize|authorise)\b/i;
    const marketingPattern = /\b(news|newsletter|updates?|offers?|promotions?|marketing|communications?|special offers?|products?\s*&?\s*services?|future information)\b/i;

    const semantic = page.locator('input[type="checkbox"], [role="checkbox"]');
    const semanticCount = await semantic.count();
    let found = false;
    let allActive = true;
    let changed = false;

    const readSemanticInfo = async checkbox => await checkbox.evaluate(el => {
      const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
      let labelText = '';
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label) labelText = label.innerText || label.textContent || '';
      }
      if (!labelText) {
        const parentLabel = el.closest('label');
        if (parentLabel) labelText = parentLabel.innerText || parentLabel.textContent || '';
      }
      if (!labelText) labelText = el.getAttribute('aria-label') || '';
      if (!labelText) {
        let ancestor = el.parentElement;
        for (let depth = 0; ancestor && ancestor !== document.body && depth < 6; depth++, ancestor = ancestor.parentElement) {
          const checkboxCount = ancestor.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length;
          const text = normalize(ancestor.innerText || ancestor.textContent || '');
          if (checkboxCount === 1 && text && text.length <= 500) {
            labelText = text;
            break;
          }
        }
      }

      const dataState = (el.getAttribute('data-state') || '').toLowerCase();
      return {
        text: normalize(labelText).slice(0, 500),
        checked: el.checked === true ||
          el.getAttribute('aria-checked') === 'true' ||
          ['checked', 'selected', 'on', 'true'].includes(dataState),
        required: el.required === true ||
          el.getAttribute('required') !== null ||
          el.getAttribute('aria-required') === 'true'
      };
    }).catch(() => null);

    for (let i = 0; i < semanticCount; i++) {
      const checkbox = semantic.nth(i);
      if (!(await checkbox.isVisible().catch(() => false))) continue;

      let info = await readSemanticInfo(checkbox);
      if (!info?.text) continue;

      const hasLegalText = legalPattern.test(info.text);
      const hasAcceptanceText = acceptancePattern.test(info.text);
      const isMarketing = marketingPattern.test(info.text);

      // If the page explicitly says Privacy Policy / Terms consent is REQUIRED to
      // continue, that requirement wins even when the same checkbox also bundles
      // future-information/marketing wording.
      const shouldBeRequired =
        info.required ||
        (hasLegalText && hasAcceptanceText && (!isMarketing || pageInfo.explicitlyRequired)) ||
        (pageInfo.explicitlyRequired && hasLegalText);

      if (!shouldBeRequired) continue;

      found = true;
      if (!info.checked) {
        console.log('Required page consent checkbox detected. Activating:', info.text);
        try {
          const tag = await checkbox.evaluate(el => el.tagName.toLowerCase());
          const type = ((await checkbox.getAttribute('type')) || '').toLowerCase();
          if (tag === 'input' && type === 'checkbox') await checkbox.check({ force: false });
          else await checkbox.click({ force: false });
        } catch {
          const clickedLabel = await checkbox.evaluate(el => {
            let label = null;
            if (el.id) label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            label = label || el.closest('label');
            if (!label) return false;
            label.click();
            return true;
          }).catch(() => false);
          if (!clickedLabel) await checkbox.click({ force: true }).catch(() => {});
        }

        await page.waitForTimeout(450);
        info = await readSemanticInfo(checkbox);
        changed = true;
      }

      if (info?.checked) {
        console.log('Required page consent is active:', info.text);
      } else {
        allActive = false;
        console.log('Required page consent is still NOT active:', info?.text || '(unknown consent)');
      }
    }

    if (found) return { found, active: allActive, changed };

    // Some funnels render a custom visual square instead of a semantic
    // input[type=checkbox]/role=checkbox. Detect the consent ROW by its text, then
    // click only the checkbox-like control/label in that row -- never the Privacy
    // Policy / Terms anchor itself.
    const custom = await page.evaluate(({ explicitlyRequired }) => {
      const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
      const legal = /\b(privacy|policy|terms?|conditions?|legal|agreement|processing|data|personal data|health data|onboarding data|information)\b/i;
      const accept = /\b(i\s+)?(?:accept|agree|consent|authorize|authorise)\b/i;
      const marketing = /\b(news|newsletter|updates?|offers?|promotions?|marketing|communications?|special offers?|products?\s*&?\s*services?|future information)\b/i;
      const visible = el => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
          r.top < window.innerHeight && r.left < window.innerWidth &&
          st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0;
      };
      const reachable = el => {
        if (!visible(el)) return false;
        const r = el.getBoundingClientRect();
        const x = Math.max(0, Math.min(window.innerWidth - 1, r.left + Math.min(r.width / 2, 18)));
        const y = Math.max(0, Math.min(window.innerHeight - 1, r.top + r.height / 2));
        const top = document.elementFromPoint(x, y);
        return !!top && (top === el || el.contains(top) || top.contains(el));
      };
      const checkedLike = el => {
        if (!el) return false;
        const state = String(el.getAttribute('data-state') || '').toLowerCase();
        const cls = String(el.className || '').toLowerCase();
        return el.getAttribute('aria-checked') === 'true' ||
          el.getAttribute('aria-selected') === 'true' ||
          ['checked', 'selected', 'on', 'true'].includes(state) ||
          /(?:^|[-_\s])(checked|selected|active)(?:$|[-_\s])/.test(cls) ||
          el.getAttribute('data-crawler-consent-activated') === 'true';
      };

      const roots = Array.from(document.querySelectorAll(
        'label, [class*="consent" i], [class*="agreement" i], [class*="privacy" i], [class*="terms" i], form, section, div'
      )).filter(visible);

      const rows = [];
      for (const el of roots) {
        const text = normalize(el.innerText || el.textContent || '');
        if (!text || text.length < 12 || text.length > 500) continue;
        const hasLegal = legal.test(text);
        const hasAccept = accept.test(text);
        const isMarketing = marketing.test(text);
        const required = hasLegal && (hasAccept || explicitlyRequired) && (!isMarketing || explicitlyRequired);
        if (!required) continue;

        const rect = el.getBoundingClientRect();
        // Avoid selecting huge page-level wrappers that merely contain the real row.
        if (rect.width > window.innerWidth * 0.98 && rect.height > window.innerHeight * 0.45) continue;

        let target = el.querySelector('input[type="checkbox"], [role="checkbox"]');
        if (!target) {
          const small = Array.from(el.querySelectorAll('*')).filter(node => {
            if (!visible(node) || node.tagName.toLowerCase() === 'a') return false;
            const r = node.getBoundingClientRect();
            const st = getComputedStyle(node);
            const classish = String(node.className || '') + ' ' + (node.id || '');
            const checkboxishName = /checkbox|check-box|consent|agreement/i.test(classish);
            const squareish = r.width >= 16 && r.width <= 64 && r.height >= 16 && r.height <= 64 &&
              Math.abs(r.width - r.height) <= 14;
            const bordered = parseFloat(st.borderTopWidth || '0') > 0 ||
              parseFloat(st.borderLeftWidth || '0') > 0;
            const clickable = node.hasAttribute('onclick') || node.tabIndex >= 0 ||
              st.cursor === 'pointer' || node.getAttribute('role') === 'button';
            return checkboxishName || (squareish && (bordered || clickable));
          }).sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return ar.left - br.left || (ar.width * ar.height) - (br.width * br.height);
          });
          target = small[0] || null;
        }

        if (!target && el.tagName.toLowerCase() === 'label') target = el;
        if (!target) {
          const clickable = Array.from(el.querySelectorAll('button, [role="button"], [onclick], [tabindex]'))
            .find(node => visible(node) && node.tagName.toLowerCase() !== 'a');
          target = clickable || null;
        }
        if (!target) {
          const st = getComputedStyle(el);
          if (el.hasAttribute('onclick') || el.tabIndex >= 0 || st.cursor === 'pointer') target = el;
        }
        if (!target || target.tagName.toLowerCase() === 'a' || !reachable(target)) continue;

        const targetRect = target.getBoundingClientRect();
        let score = 0;
        if (el.tagName.toLowerCase() === 'label') score += 100;
        if (/checkbox|check-box/i.test(String(target.className || '') + ' ' + (target.id || ''))) score += 90;
        if (targetRect.width <= 64 && targetRect.height <= 64) score += 70;
        if (targetRect.left < window.innerWidth * 0.35) score += 40;
        score -= Math.min(rect.height, 300) / 10;

        rows.push({ el, target, text, score, checked: checkedLike(target) || checkedLike(el) });
      }

      if (!rows.length) return null;
      rows.sort((a, b) => b.score - a.score);
      const chosen = rows[0];
      const id = 'crawler-custom-consent-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
      chosen.target.setAttribute('data-crawler-custom-consent-id', id);
      chosen.el.setAttribute('data-crawler-custom-consent-row', id);
      return { id, text: chosen.text, checked: chosen.checked };
    }, { explicitlyRequired: pageInfo.explicitlyRequired }).catch(() => null);

    if (!custom && pageInfo.explicitlyRequired) {
      // Custom agreements may have a bare square as a sibling of the text, with
      // no checkbox role and no usable label association. Locate the smallest
      // legal-text element first, then search its ancestor row for a visual box.
      const candidate = await page.evaluate(() => {
        const norm = text => String(text || '').replace(/\s+/g, ' ').trim();
        const legal = /\b(privacy\s+policy|terms(?:\s+(?:and|&)\s+conditions)?|legal\s+agreement|data\s+processing|policy)\b/i;
        const accept = /\b(agree|accept|consent|authorize|authorise)\b/i;
        const visible = el => {
          const r = el.getBoundingClientRect(), st = getComputedStyle(el);
          return r.width >= 12 && r.height >= 12 && r.top >= 0 &&
            r.bottom <= innerHeight && st.display !== 'none' &&
            st.visibility !== 'hidden' && st.opacity !== '0';
        };
        const nodes = Array.from(document.querySelectorAll('p, span, label, div'))
          .filter(el => {
            const t = norm(el.innerText);
            return t.length > 18 && t.length < 300 && legal.test(t) && accept.test(t) && visible(el);
          }).sort((a,b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height);
        for (const label of nodes) {
          const labelRect = label.getBoundingClientRect();
          for (let row = label.parentElement, depth = 0; row && depth < 4; row = row.parentElement, depth++) {
            const rr = row.getBoundingClientRect();
            if (rr.height > 180 || rr.width > innerWidth + 5) continue;
            const choices = Array.from(row.querySelectorAll('*')).filter(el => {
              if (el === label || label.contains(el) || el.closest('a, button, input[type="submit"]')) return false;
              if (!visible(el)) return false;
              const r = el.getBoundingClientRect(), st = getComputedStyle(el);
              return r.width >= 14 && r.width <= 60 && r.height >= 14 && r.height <= 60 &&
                Math.abs(r.width-r.height) <= 15 && r.right <= labelRect.left + 18 &&
                Math.abs((r.top + r.bottom)/2 - (labelRect.top + labelRect.bottom)/2) < 65 &&
                (parseFloat(st.borderTopWidth) > 0 || parseFloat(st.borderLeftWidth) > 0 ||
                 st.cursor === 'pointer' || /checkbox|check|consent/i.test(String(el.className)));
            }).sort((x,y) => {
              const xr=x.getBoundingClientRect(),yr=y.getBoundingClientRect();
              return (Math.abs(xr.right-labelRect.left) + xr.width*xr.height/100) -
                (Math.abs(yr.right-labelRect.left) + yr.width*yr.height/100);
            });
            if (!choices.length) continue;
            const target = choices[0], id = 'crawler-required-agreement-' + Math.random().toString(36).slice(2);
            target.setAttribute('data-crawler-required-agreement', id);
            return { id, text: norm(label.innerText) };
          }
        }
        return null;
      }).catch(() => null);
      if (candidate) {
        const target = page.locator('[data-crawler-required-agreement="' + candidate.id + '"]');
        console.log('Required legal checkbox candidate found:', candidate.text);
        const clicked = await safeCrawlerClick(target, 'required policy checkbox');
        if (!clicked) return { found: true, active: false, changed: false };
        await page.waitForTimeout(450);
        const validationStillVisible = await page.getByText(/accept\s+(?:the\s+)?(?:privacy\s+policy|terms|policy)\s+to\s+continue/i)
          .first().isVisible().catch(() => false);
        const checked = await target.evaluate(el => {
          const root = el.parentElement;
          return el.checked === true || el.getAttribute('aria-checked') === 'true' ||
            /checked|selected/.test((el.getAttribute('data-state') || '').toLowerCase()) ||
            (root && (root.querySelector('input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"]') !== null));
        }).catch(() => false);
        if (validationStillVisible && !checked) {
          console.log('Agreement click attempted; validation remains and checked state could not be confirmed.');
          return { found: true, active: false, changed: true };
        }
        console.log('Agreement candidate clicked; state:', checked ? 'checked' : 'validation absent');
        return { found: true, active: true, changed: true };
      }
      console.log('Required legal acceptance message detected, but no safe checkbox target was found.');
      return { found: true, active: false, changed: false };
    }

    if (!custom) return { found: false, active: true, changed: false };
    found = true;

    if (custom.checked) {
      console.log('Required custom page consent is already active:', custom.text);
      return { found: true, active: true, changed: false };
    }

    console.log('Required custom page consent detected. Activating:', custom.text);
    const customTarget = page.locator(`[data-crawler-custom-consent-id="${custom.id}"]`);
    const customClicked = await safeCrawlerClick(customTarget, 'required custom consent checkbox');
    if (!customClicked) {
      console.log('Required custom page consent could not be clicked.');
      return { found: true, active: false, changed: false };
    }

    await customTarget.evaluate(el => el.setAttribute('data-crawler-consent-activated', 'true')).catch(() => {});
    await page.waitForTimeout(500);
    console.log('Required custom page consent click registered.');
    return { found: true, active: true, changed: true };
  }

  async function handleRequiredAgreementCheckboxes(input) {
    const pageConsentState = await handleRequiredPageConsentCheckboxes();
    if (pageConsentState.found) {
      await input.evaluate(el => el.blur?.()).catch(() => {});
      await page.waitForTimeout(350);
      return { found: true, active: pageConsentState.active };
    }

    const legalPattern = /\b(terms?|conditions?|privacy|policy|legal|agreement|processing|data processing)\b/i;
    const acceptancePattern = /\b(accept|agree|consent|required|must)\b/i;
    const marketingPattern = /\b(news|newsletter|updates?|offers?|promotions?|marketing|communications?|products?\s*&?\s*services?|special offers?)\b/i;
    const candidates = page.locator('input[type="checkbox"], [role="checkbox"]');
    const count = await candidates.count();
    let legalFound = false;
    let allLegalActive = true;
    for (let i = 0; i < count; i++) {
      const checkbox = candidates.nth(i);
      if (!(await checkbox.isVisible().catch(() => false))) continue;
      const getInfo = async () => await checkbox.evaluate(el => {
        let labelText = '';
        if (el.id) {
          const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (label) labelText = label.innerText || label.textContent || '';
        }
        if (!labelText) {
          const parentLabel = el.closest('label');
          if (parentLabel) labelText = parentLabel.innerText || parentLabel.textContent || '';
        }
        if (!labelText) labelText = el.getAttribute('aria-label') || '';
        if (!labelText) {
          let ancestor = el.parentElement;
          let depth = 0;
          while (ancestor && depth < 5) {
            const checkboxCount = ancestor.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length;
            const text = (ancestor.innerText || ancestor.textContent || '').trim().replace(/\s+/g, ' ');
            if (checkboxCount === 1 && text.length > 0 && text.length <= 350) {
              labelText = text;
              break;
            }
            ancestor = ancestor.parentElement;
            depth++;
          }
        }
        return {
          text: labelText.trim().replace(/\s+/g, ' ').slice(0, 350),
          checked: el.checked === true || el.getAttribute('aria-checked') === 'true',
          required: el.required === true || el.getAttribute('required') !== null || el.getAttribute('aria-required') === 'true'
        };
      });
      let info = await getInfo();
      if (!info.text) continue;
      const isMarketing = marketingPattern.test(info.text);
      const isLegalAgreement = legalPattern.test(info.text) && (acceptancePattern.test(info.text) || info.required);

      // Marketing/newsletter consent is optional by default. Actively keep it OFF,
      // including when a funnel pre-checks it. Never opt into updates, promotions,
      // newsletters, product/service emails, or special offers unless that checkbox
      // is genuinely required to submit the form.
      if (isMarketing && !info.required) {
        if (info.checked) {
          console.log('Optional marketing/email checkbox is preselected. Turning it off:', info.text);
          try {
            const tag = await checkbox.evaluate(el => el.tagName.toLowerCase());
            const type = ((await checkbox.getAttribute('type')) || '').toLowerCase();
            if (tag === 'input' && type === 'checkbox') await checkbox.uncheck({ force: true });
            else await checkbox.click({ force: true });
          } catch {
            await checkbox.click({ force: true }).catch(() => {});
          }
          await page.waitForTimeout(300);
          info = await getInfo();
        } else {
          console.log('Optional marketing/email checkbox left unselected:', info.text);
        }
        continue;
      }

      if (!isLegalAgreement) continue;
      legalFound = true;
      for (let attempt = 1; attempt <= 3 && !info.checked; attempt++) {
        console.log('Required legal agreement checkbox detected:', info.text);
        try {
          const tag = await checkbox.evaluate(el => el.tagName.toLowerCase());
          const type = ((await checkbox.getAttribute('type')) || '').toLowerCase();
          if (tag === 'input' && type === 'checkbox') await checkbox.check({ force: attempt > 1 });
          else await checkbox.click({ force: attempt > 1 });
        } catch {
          const clickedLabel = await checkbox.evaluate(el => {
            let label = null;
            if (el.id) label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            label = label || el.closest('label');
            if (!label) return false;
            label.click();
            return true;
          });
          if (!clickedLabel) await checkbox.click({ force: true }).catch(() => {});
        }
        await page.waitForTimeout(450);
        info = await getInfo();
      }
      if (info.checked) console.log('Required legal agreement is active:', info.text);
      else {
        allLegalActive = false;
        console.log('Required legal agreement is still NOT active:', info.text);
      }
    }
    if (legalFound) {
      await input.evaluate(el => el.blur());
      await page.waitForTimeout(700);
    }
    return { found: legalFound, active: !legalFound || allLegalActive };
  }

  async function findBottomPrimaryFormAction(input) {
    const inputBox = await input.boundingBox();
    if (!inputBox) return null;

    const formInputId = await input.evaluate(el => {
      let id = el.getAttribute('data-crawler-form-input-id');
      if (!id) {
        id = `crawler-form-input-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
        el.setAttribute('data-crawler-form-input-id', id);
      }
      return id;
    });

    const candidates = page.locator('button, [role="button"], input[type="submit"], input[type="button"], a, [onclick]');
    const count = await candidates.count();
    let best = null;

    for (let i = 0; i < count; i++) {
      const candidate = candidates.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const box = await candidate.boundingBox();
      if (!box || box.width < 90 || box.height < 30) continue;

      const info = await candidate.evaluate((el, inputId) => {
        const inputEl = document.querySelector(`[data-crawler-form-input-id="${CSS.escape(inputId)}"]`);
        if (!inputEl) return null;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const inputRect = inputEl.getBoundingClientRect();
        const centerX = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
        const centerY = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
        const topElement = document.elementFromPoint(centerX, centerY);
        const reachable = !!topElement && (topElement === el || el.contains(topElement) || topElement.contains(el));

        const inputForm = inputEl.closest('form');
        const candidateForm = el.closest('form');
        const sameForm = !!inputForm && inputForm === candidateForm;

        const panelSelector = '[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="dialog" i], [class*="popup" i], [class*="overlay" i], [class*="sheet" i], [class*="drawer" i], [class*="gate" i], [class*="unlock" i]';
        const inputPanel = inputEl.closest(panelSelector);
        const candidatePanel = el.closest(panelSelector);
        const sameExplicitPanel = !!inputPanel && inputPanel === candidatePanel;

        const commonAncestor = (() => {
          let node = inputEl.parentElement;
          let depth = 0;
          while (node && node !== document.body && depth < 8) {
            if (node.contains(el)) {
              const r = node.getBoundingClientRect();
              if (r.width >= Math.min(window.innerWidth * 0.55, 220) && r.height >= 120) return node;
            }
            node = node.parentElement;
            depth++;
          }
          return null;
        })();

        const sameContainer = !!commonAncestor;
        const verticalGap = rect.top - inputRect.bottom;
        const horizontalCenterDistance = Math.abs((rect.left + rect.width / 2) - (inputRect.left + inputRect.width / 2));
        const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true' || style.pointerEvents === 'none';
        return {
          text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('value') || '').trim().replace(/\s+/g, ' ').slice(0, 100),
          disabled,
          opacity: Number(style.opacity || 1),
          type: (el.getAttribute('type') || '').toLowerCase(),
          reachable,
          sameForm,
          sameExplicitPanel,
          sameContainer,
          verticalGap,
          horizontalCenterDistance,
          widthRatio: rect.width / window.innerWidth,
          bottomRatio: rect.bottom / Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, window.innerHeight)
        };
      }, formInputId).catch(() => null);

      if (!info || info.disabled || info.opacity < 0.35 || !info.reachable) continue;
      if (info.verticalGap < -24) continue;

      // Legal/help/footer links can sit directly under the email field and score
      // highly by proximity. They are not submission controls.
      const formActionText = (info.text || '').trim();
      if (/^(?:privacy(?: policy)?|terms(?: & conditions)?|terms and conditions|conditions|legal|cookie(?: policy)?|learn more|help|support)$/i.test(formActionText)) {
        continue;
      }

      let score = 0;
      if (info.sameForm) score += 320;
      if (info.sameExplicitPanel) score += 240;
      if (info.sameContainer) score += 140;
      if (info.type === 'submit') score += 80;
      if (info.verticalGap >= -24 && info.verticalGap <= 180) score += 100;
      else if (info.verticalGap <= 320) score += 45;
      if (info.horizontalCenterDistance <= 80) score += 45;
      if (info.widthRatio >= 0.65) score += 55;
      else if (info.widthRatio >= 0.40) score += 30;
      score += Math.min(Math.max(info.bottomRatio, 0), 1) * 30;
      if (info.text.length > 0 && info.text.length <= 50) score += 10;

      if (!best || score > best.score) best = { locator: candidate, text: info.text, score };
    }

    if (best) console.log('Foreground form CTA candidate:', best.text || '(no text)');
    return best;
  }

  async function getVisibleFormIntentText() {
    return await page.evaluate(() => {
      const visible = el => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
          r.top < window.innerHeight && r.left < window.innerWidth &&
          st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0;
      };
      const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
      const parts = [];
      const seen = new Set();
      const add = text => {
        const normalized = normalize(text);
        if (!normalized || normalized.length > 220 || seen.has(normalized)) return;
        seen.add(normalized);
        parts.push(normalized);
      };

      for (const selector of ['h1', 'h2', 'h3', '[role="heading"]', 'label', 'legend', '[aria-label]']) {
        for (const el of document.querySelectorAll(selector)) {
          if (!visible(el)) continue;
          add(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
        }
      }

      // Some funnels render the real question as a styled div/span, not a semantic
      // heading. Read prominent text in the CURRENT viewport as additional intent.
      for (const el of document.querySelectorAll('div, p, span')) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.top > window.innerHeight * 0.62) continue;
        const text = normalize(el.innerText || el.textContent || '');
        if (!text || text.length > 160) continue;
        const st = getComputedStyle(el);
        const fontSize = parseFloat(st.fontSize || '0');
        const fontWeight = parseInt(st.fontWeight || '400', 10) || 400;
        if (fontSize < 17 && fontWeight < 550) continue;
        add(text);
      }
      return normalize(parts.join(' ')).slice(0, 1600);
    }).catch(() => '');
  }

  async function detectExplicitProfileIntent() {
    return await page.evaluate(() => {
      const normalize = value => (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const visible = el => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
          r.top < window.innerHeight && r.left < window.innerWidth &&
          st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0;
      };

      const candidates = [];
      const seen = new Set();
      for (const el of document.querySelectorAll('h1, h2, h3, [role="heading"], label, legend, div, p, span')) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.top > window.innerHeight * 0.62) continue;
        const text = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
        if (!text || text.length > 170 || seen.has(text)) continue;
        const st = getComputedStyle(el);
        const fontSize = parseFloat(st.fontSize || '0');
        const fontWeight = parseInt(st.fontWeight || '400', 10) || 400;
        const semanticHeading = /^h[1-3]$/i.test(el.tagName) || el.getAttribute('role') === 'heading';
        if (!semanticHeading && fontSize < 17 && fontWeight < 550) continue;
        seen.add(text);
        let score = 0;
        if (semanticHeading) score += 80;
        if (fontSize >= 24) score += 70;
        else if (fontSize >= 20) score += 45;
        else if (fontSize >= 17) score += 20;
        if (fontWeight >= 600) score += 35;
        score += Math.max(0, 45 - (r.top / Math.max(window.innerHeight, 1)) * 45);
        candidates.push({ text, score });
      }
      candidates.sort((a, b) => b.score - a.score);

      const joined = candidates.slice(0, 20).map(x => x.text).join(' | ');
      const checks = [
        ['goal-weight', /\b(?:goal|target|desired)\s+weight\b|what(?:'s| is) your goal weight/],
        ['current-weight', /\bcurrent\s+weight\b|what(?:'s| is) your current weight|how much do you weigh/],
        ['height', /\bhow tall are you\b|\b(?:your )?height\b|enter (?:your )?height/],
        ['name', /\bwhat(?:'s| is) your name\b|\benter (?:your )?name\b|\byour name\b/],
        ['age', /\bhow old are you\b|\bchoose your age\b|\bselect your age\b|\b(?:your )?age\b/]
      ];
      for (const [type, pattern] of checks) {
        if (pattern.test(joined)) return { type, evidence: joined.slice(0, 500) };
      }
      return null;
    }).catch(() => null);
  }

  async function findSemanticFormControl(intentType) {
    return await page.evaluate((wantedIntent) => {
      const normalize = value => (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const intentWords = {
        height: ['height', 'tall', 'cm', 'ft', 'feet'],
        'current-weight': ['current weight', 'weight', 'weigh', 'kg', 'lbs'],
        'goal-weight': ['goal weight', 'target weight', 'desired weight', 'kg', 'lbs'],
        age: ['age', 'old'],
        name: ['name', 'first name', 'your name']
      }[wantedIntent] || [];

      const candidates = Array.from(document.querySelectorAll(
        'input, textarea, [contenteditable="true"], [role="textbox"], [role="spinbutton"]'
      ));
      const scored = [];

      for (const el of candidates) {
        const tag = el.tagName.toLowerCase();
        const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
        if (type === 'hidden' || el.disabled === true || el.getAttribute('aria-disabled') === 'true') continue;

        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        const visibleBox = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
          rect.top < window.innerHeight && rect.left < window.innerWidth;

        let labelText = '';
        if (el.id) {
          const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (label) labelText = label.innerText || label.textContent || '';
        }
        if (!labelText) {
          const parentLabel = el.closest('label');
          if (parentLabel) labelText = parentLabel.innerText || parentLabel.textContent || '';
        }

        let nearbyText = '';
        let ancestor = el.parentElement;
        let depth = 0;
        while (ancestor && ancestor !== document.body && depth < 5) {
          const text = normalize(ancestor.innerText || ancestor.textContent || '');
          if (text && text.length <= 500) nearbyText += ' ' + text;
          ancestor = ancestor.parentElement;
          depth++;
        }

        const signals = normalize([
          el.getAttribute('name'), el.getAttribute('placeholder'), el.getAttribute('autocomplete'),
          el.getAttribute('aria-label'), el.getAttribute('title'), el.id, el.className && String(el.className),
          labelText, nearbyText
        ].filter(Boolean).join(' '));

        let score = visibleBox ? 120 : 25;
        if (tag === 'input' || tag === 'textarea') score += 30;
        if (el.isContentEditable || el.getAttribute('role') === 'textbox' || el.getAttribute('role') === 'spinbutton') score += 35;
        if (['number', 'tel'].includes(type) || el.getAttribute('inputmode') === 'numeric' || el.getAttribute('inputmode') === 'decimal') {
          if (wantedIntent !== 'name') score += 45;
        }
        if ((type === 'text' || tag === 'textarea' || el.getAttribute('role') === 'textbox') && wantedIntent === 'name') score += 45;
        for (const word of intentWords) if (signals.includes(word)) score += 35;
        if (wantedIntent === 'goal-weight' && /goal|target|desired/.test(signals)) score += 80;
        if (wantedIntent === 'current-weight' && /current|weigh/.test(signals)) score += 60;
        if (wantedIntent === 'height' && /height|tall/.test(signals)) score += 70;
        if (wantedIntent === 'age' && /age|old/.test(signals)) score += 70;
        if (wantedIntent === 'name' && /name/.test(signals)) score += 70;

        scored.push({ el, score, visibleBox });
      }

      if (!scored.length) return null;
      scored.sort((a, b) => b.score - a.score || Number(b.visibleBox) - Number(a.visibleBox));
      const chosen = scored[0];
      if (chosen.score < 45) return null;
      const id = `crawler-semantic-input-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
      chosen.el.setAttribute('data-crawler-semantic-input-id', id);
      return { id, score: chosen.score, visibleBox: chosen.visibleBox };
    }, intentType).catch(() => null);
  }

  async function fillSemanticFormControl(control, value) {
    const text = String(value);
    const editable = await control.isEditable().catch(() => false);
    if (editable) {
      try {
        await control.fill(text);
        await control.evaluate(el => {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur?.();
        });
        await page.waitForTimeout(450);
        return true;
      } catch {}
    }

    const changed = await control.evaluate((nextValue) => {
      const el = this;
      return false;
    }, text).catch(() => false);
    if (changed) return true;

    return await control.evaluate((nextValue) => {
      const el = arguments[0] && this ? this : null;
      return false;
    }, text).catch(() => false);
  }

  async function forceSetSemanticFormControl(control, value) {
    const text = String(value);
    return await control.evaluate((el, nextValue) => {
      try {
        if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
          el.focus?.();
          el.textContent = nextValue;
        } else if ('value' in el) {
          const proto = el.tagName.toLowerCase() === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
          if (descriptor?.set) descriptor.set.call(el, nextValue);
          else el.value = nextValue;
        } else {
          el.textContent = nextValue;
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur?.();
        return true;
      } catch {
        return false;
      }
    }, text).catch(() => false);
  }

  async function writeSemanticFormControl(control, value) {
    if (await control.isEditable().catch(() => false)) {
      try {
        await control.fill(String(value));
        await control.evaluate(el => {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur?.();
        });
        await page.waitForTimeout(500);
        return true;
      } catch {}
    }
    const changed = await forceSetSemanticFormControl(control, value);
    if (changed) await page.waitForTimeout(500);
    return changed;
  }

  async function handleProfileNumericInput(state, screenNumber = null) {
    const pageText = (state?.pageText || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!pageText) return { recognized: false, advanced: false };

    // Route the page from what is visibly being asked, before relying on the
    // implementation details of the field itself.
    const explicitIntent = await detectExplicitProfileIntent();
    const visibleIntent = (await getVisibleFormIntentText()).toLowerCase().replace(/\s+/g, ' ').trim();
    const semanticText = `${visibleIntent} ${pageText}`.replace(/\s+/g, ' ').trim();

    if (explicitIntent?.type === 'name') {
      return { recognized: false, advanced: false };
    }

    let profileType = ['height', 'current-weight', 'goal-weight', 'age'].includes(explicitIntent?.type)
      ? explicitIntent.type
      : null;
    if (!profileType) {
      if (/\b(goal|target|desired)\s+weight\b|what(?:'s| is) your goal weight|goal weight/i.test(semanticText)) {
        profileType = 'goal-weight';
      } else if (/\bcurrent\s+weight\b|what(?:'s| is) your current weight\b|\bhow much do you weigh\b/i.test(semanticText)) {
        profileType = 'current-weight';
      } else if (/\bhow tall are you\b|\byour height\b|\bheight\b/i.test(semanticText)) {
        profileType = 'height';
      } else if (/\bhow old are you\b|\byour age\b|\bage\b/i.test(semanticText)) {
        profileType = 'age';
      }
    }
    if (!profileType) return { recognized: false, advanced: false };
    if (explicitIntent?.type === profileType) {
      console.log(`Explicit profile page intent detected: ${profileType}.`);
    }

    const fields = page.locator(
      'input:not([type]), input[type="text"], input[type="number"], input[type="tel"], input[inputmode="numeric"], input[inputmode="decimal"], [contenteditable="true"], [role="textbox"], [role="spinbutton"]'
    );
    const count = await fields.count();
    const editable = [];
    for (let i = 0; i < count; i++) {
      const field = fields.nth(i);
      if (!(await field.isEnabled().catch(() => true))) continue;
      if (!(await field.isVisible().catch(() => false))) continue;
      editable.push(field);
    }

    // Marketing/transition pages can mention "target weight" inside a phone
    // mockup while offering only CONTINUE. Do not fill a hidden DOM input or
    // capture fake weight variants when no visible field is available.
    if (shouldFollowProfileContinue(state, editable.length)) {
      console.log('Profile wording found without a visible input. Following the Continue CTA instead of a hidden form control.');
      return { recognized: false, advanced: false };
    }

    // Some funnels implement profile fields as custom React controls, hidden native
    // inputs, contenteditable nodes, or role=textbox/spinbutton elements. Once the
    // visible page intent says height/weight/age, do not give up simply because the
    // ordinary input selector missed the implementation.
    if (!editable.length) {
      const semanticControl = await findSemanticFormControl(profileType);
      if (semanticControl?.id) {
        console.log(`Semantic ${profileType} page detected; using its custom form control.`);
        editable.push(page.locator(`[data-crawler-semantic-input-id="${semanticControl.id}"]`));
      }
    }
    if (!editable.length) {
      console.log(`Semantic ${profileType} page detected, but no writable control could be found.`);
      return { recognized: true, advanced: false };
    }

    async function clickPreferredUnit(labelPattern, description) {
      const candidates = page.locator('button, [role="button"], label, [role="radio"], [role="tab"]');
      const n = await candidates.count();
      for (let i = 0; i < n; i++) {
        const candidate = candidates.nth(i);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const text = ((await candidate.innerText().catch(() => '')) || (await candidate.getAttribute('aria-label')) || '').trim();
        if (!labelPattern.test(text)) continue;
        const selected = await candidate.evaluate(el =>
          el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' ||
          el.classList.contains('active') || el.classList.contains('selected')
        ).catch(() => false);
        if (!selected) await safeCrawlerClick(candidate, description);
        await page.waitForTimeout(250);
        return true;
      }
      return false;
    }

    async function fillNumeric(field, value) {
      const written = await writeSemanticFormControl(field, value);
      if (!written) throw new Error(`Unable to write semantic ${profileType} value: ${value}`);
      await page.waitForTimeout(250);
    }

    async function captureProfileVariant(value, reason) {
      if (screenNumber === null) return;
      await waitForScreenshotReady({ minimumWaitMs: 700, maxWaitMs: 2200, pollMs: 250 });
      const filename = nextSupplementalFilename(screenNumber);
      await page.screenshot({ path: filename, fullPage: true });
      console.log(`Captured ${path.basename(filename)} for ${reason}: ${value}`);
    }

    async function submitProfileField(field, fieldType) {
      const agreementState = await handleRequiredAgreementCheckboxes(field);
      if (!agreementState.active) return { recognized: true, advanced: false };
      await page.waitForTimeout(500);
      const beforeSubmitState = await inspectPageNavigationSafe(`${fieldType} submit inspection`);
      const beforeSignature = pageSignature(beforeSubmitState);

      const form = field.locator('xpath=ancestor::form[1]');
      if ((await form.count()) > 0) {
        const submit = form.locator('button[type="submit"], input[type="submit"], button:not([type])').first();
        if ((await submit.count()) > 0 && (await submit.isVisible().catch(() => false)) && (await submit.isEnabled().catch(() => false))) {
          const clicked = await safeCrawlerClick(submit, `${fieldType} form submit control`);
          if (clicked && await waitForAdvancement(beforeSignature, 12000)) return { recognized: true, advanced: true };
        }
      }

      const nearbyAction = await findBottomPrimaryFormAction(field);
      if (nearbyAction) {
        const clicked = await safeCrawlerClick(nearbyAction.locator, nearbyAction.text || `${fieldType} bottom primary CTA`);
        if (clicked && await waitForAdvancement(beforeSignature, 12000)) return { recognized: true, advanced: true };
      }

      // Custom/hidden semantic controls may not have a usable bounding box, so the
      // input-relative CTA finder can legitimately return null. In that case use the
      // page-level bottom navigation detector (NEXT STEP / CONTINUE / NEXT).
      const bottomAction = await findBottomNavigationFallback();
      if (bottomAction) {
        const clicked = await safeCrawlerClick(
          page.locator(`[data-bottom-navigation-id="${bottomAction.id}"]`),
          bottomAction.text || `${fieldType} bottom navigation CTA`
        );
        if (clicked && await waitForAdvancement(beforeSignature, 12000)) return { recognized: true, advanced: true };
      }

      console.log(`Trying Enter for ${fieldType} input.`);
      await field.press('Enter').catch(() => {});
      if (await waitForAdvancement(beforeSignature, 8000)) return { recognized: true, advanced: true };
      console.log(`Unable to safely submit ${fieldType} field.`);
      return { recognized: true, advanced: false };
    }

    if (profileType === 'height') {
      console.log('Detected height input. Preferring 180 cm (6 ft fallback).');
      const metricAvailable = await clickPreferredUnit(/^cm$/i, 'height unit cm');
      if (metricAvailable || editable.length === 1) {
        await fillNumeric(editable[0], 180);
      } else {
        await clickPreferredUnit(/^(ft|feet)$/i, 'height unit feet');
        await fillNumeric(editable[0], 6);
        if (editable[1]) await fillNumeric(editable[1], 0);
      }
      return await submitProfileField(editable[0], 'height');
    }

    if (profileType === 'age') {
      console.log('Detected age input. Using age 25.');
      await fillNumeric(editable[0], 25);
      return await submitProfileField(editable[0], 'age');
    }

    if (profileType === 'current-weight') {
      console.log('Detected current-weight input. Testing 50, 70, 80, 100 kg; continuing with 80 kg.');
      await clickPreferredUnit(/^kg$/i, 'weight unit kg');
      for (const value of [50, 70, 80, 100]) {
        await fillNumeric(editable[0], value);
        await captureProfileVariant(value, 'current-weight response');
      }
      await fillNumeric(editable[0], 80);
      console.log('Current weight locked for continuation: 80 kg.');
      return await submitProfileField(editable[0], 'current-weight');
    }

    if (profileType === 'goal-weight') {
      console.log('Detected goal-weight input. Testing 75, 70, 60 kg; continuing with 70 kg.');
      await clickPreferredUnit(/^kg$/i, 'goal-weight unit kg');
      for (const value of [75, 70, 60]) {
        await fillNumeric(editable[0], value);
        await captureProfileVariant(value, 'goal-weight response');
      }
      await fillNumeric(editable[0], 70);
      console.log('Goal weight locked for continuation: 70 kg.');
      return await submitProfileField(editable[0], 'goal-weight');
    }

    return { recognized: false, advanced: false };
  }

  async function emailRejectionDetected(input) {
    const details = await input.evaluate(el => {
      const texts = [];
      const add = value => {
        const text = (value || '').replace(/\s+/g, ' ').trim();
        if (text) texts.push(text);
      };

      const visible = node => node.getClientRects().length > 0 &&
        getComputedStyle(node).visibility !== 'hidden';
      add(el.validationMessage || '');

      const errorMessageId = el.getAttribute('aria-errormessage');
      if (errorMessageId) {
        const node = document.getElementById(errorMessageId);
        if (node && visible(node)) add(node.innerText || node.textContent || '');
      }

      const describedBy = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      for (const id of describedBy) {
        const node = document.getElementById(id);
        if (node && visible(node) && (el.getAttribute('aria-invalid') === 'true' ||
            node.matches('[role="alert"], [class*="error" i], [class*="invalid" i]'))) {
          add(node.innerText || node.textContent || '');
        }
      }

      let ancestor = el.parentElement;
      for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parentElement) {
        for (const node of ancestor.querySelectorAll(
          '[role="alert"], [aria-live="assertive"], [class*="error" i], [class*="invalid" i]'
        )) {
          if (visible(node)) add(node.innerText || node.textContent || '');
        }
      }

      return texts.join(' | ');
    }).catch(() => '');

    const alerts = await page.evaluate(() => Array.from(document.querySelectorAll(
      '[role="alert"], [aria-live="assertive"]'
    )).filter(node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden')
      .map(node => node.innerText || node.textContent || '').join(' | ')).catch(() => '');
    return isEmailRejection(details) || isEmailRejection(alerts);
  }

  async function retryWithNextEmailIfNeeded(input) {
    if (currentRunEmail() !== BASE_RUN_EMAIL) return null;
    if ((await input.inputValue().catch(() => '')) !== BASE_RUN_EMAIL) return null;
    if (!(await emailRejectionDetected(input))) return null;

    const nextEmail = advanceRunEmail();
    if (!nextEmail) return null;
    console.log('Primary email rejected. Retrying with the configured backup email.');

    await input.fill(nextEmail);
    await input.evaluate(el => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    });

    await page.waitForTimeout(900);
    return nextEmail;
  }

  async function handleGenericFormInput(state) {
    const visibleFormIntent = (await getVisibleFormIntentText()).toLowerCase().replace(/\s+/g, ' ').trim();
    const explicitProfileIntent = await detectExplicitProfileIntent();

    // Name is also routed from the visible task, not from input metadata alone.
    if (explicitProfileIntent?.type === 'name' || /\bwhat(?:'s| is) your name\b|\benter (?:your )?name\b|\byour name\b/i.test(visibleFormIntent)) {
      if (explicitProfileIntent?.type === 'name') console.log('Explicit profile page intent detected: name.');
      const semanticName = await findSemanticFormControl('name');
      if (semanticName?.id) {
        const input = page.locator(`[data-crawler-semantic-input-id="${semanticName.id}"]`);
        console.log('Detected name input from page intent.');
        const written = await writeSemanticFormControl(input, 'Hami');
        if (!written) return { recognized: true, advanced: false };
        const agreementState = await handleRequiredAgreementCheckboxes(input);
        if (!agreementState.active) return { recognized: true, advanced: false };
        await page.waitForTimeout(400);
        const beforeSubmitState = await inspectPageNavigationSafe('name submit inspection');
        const beforeSignature = pageSignature(beforeSubmitState);
        const nearbyAction = await findBottomPrimaryFormAction(input);
        if (nearbyAction) {
          const clicked = await safeCrawlerClick(nearbyAction.locator, nearbyAction.text || 'name bottom primary CTA');
          if (clicked && await waitForAdvancement(beforeSignature, 12000)) return { recognized: true, advanced: true };
        }
        const bottomAction = await findBottomNavigationFallback();
        if (bottomAction) {
          const clicked = await safeCrawlerClick(
            page.locator(`[data-bottom-navigation-id="${bottomAction.id}"]`),
            bottomAction.text || 'name bottom navigation CTA'
          );
          if (clicked && await waitForAdvancement(beforeSignature, 12000)) return { recognized: true, advanced: true };
        }
        await input.press('Enter').catch(() => {});
        if (await waitForAdvancement(beforeSignature, 8000)) return { recognized: true, advanced: true };
        return { recognized: true, advanced: false };
      }
    }
    const fields = page.locator(
      'input:not([type]), input[type="text"], input[type="email"], input[type="password"], textarea'
    );
    const count = await fields.count();
    const pendingFields = [];
    for (let i = 0; i < count; i++) {
      const input = fields.nth(i);
      if (!(await input.isVisible()) || !(await input.isEnabled()) || !(await input.isEditable())) continue;
      const info = await input.evaluate(el => {
        let labelText = '';
        if (el.id) {
          const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (label) labelText = label.innerText || label.textContent || '';
        }
        if (!labelText) {
          const parentLabel = el.closest('label');
          if (parentLabel) labelText = parentLabel.innerText || parentLabel.textContent || '';
        }
        return {
          type: (el.getAttribute('type') || 'text').toLowerCase(),
          name: (el.getAttribute('name') || '').toLowerCase(),
          placeholder: (el.getAttribute('placeholder') || '').toLowerCase(),
          autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
          ariaLabel: (el.getAttribute('aria-label') || '').toLowerCase(),
          label: labelText.trim().toLowerCase()
        };
      });
      const fieldType = genericFormFieldType(info, visibleFormIntent);
      const value = fieldType === 'password' ? RUN_PASSWORD :
        fieldType === 'email' ? currentRunEmail() : fieldType === 'name' ? 'Hami' : null;
      if (!value) continue;
      console.log(`Detected ${fieldType} input.`);
      await input.fill(value);
      if (fieldType === 'email') {
        const actualEmailState = await input.evaluate(el => ({
          value: el.value,
          valid: el.validity ? el.validity.valid : null,
          validationMessage: el.validationMessage || ''
        }));
        console.log('EMAIL DEBUG - intended value:', value);
        console.log('EMAIL DEBUG - actual field value:', actualEmailState.value);
        console.log('EMAIL DEBUG - browser valid:', actualEmailState.valid);
        console.log('EMAIL DEBUG - validation message:', actualEmailState.validationMessage || '(none)');
      }
      await input.evaluate(el => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
      });
      await page.waitForTimeout(500);
      pendingFields.push({ input, fieldType });
    }
    // A validation error changes page text too; it must not count as advancement.
    async function waitForFormAdvancement(beforeSignature, timeoutMs) {
      const advanced = await waitForAdvancement(beforeSignature, timeoutMs);
      if (!advanced) return false;
      for (const field of pendingFields) {
        if (field.fieldType === 'email' && await field.input.isVisible().catch(() => false) &&
            await emailRejectionDetected(field.input)) return false;
      }
      return true;
    }
    // Fill password/confirmation fields before submitting a combined signup form.
    // Submit through its email field first so any rejection uses the bounded retry.
    pendingFields.sort((a, b) => Number(b.fieldType === 'email') - Number(a.fieldType === 'email'));
    for (const { input, fieldType } of pendingFields) {
      const agreementState = await handleRequiredAgreementCheckboxes(input);
      if (!agreementState.active) return { recognized: true, advanced: false };
      const beforeSubmitState = await inspectPage();
      const beforeSignature = pageSignature(beforeSubmitState);
      const form = input.locator('xpath=ancestor::form[1]');
      if ((await form.count()) > 0) {
        const submit = form.locator('button[type="submit"], input[type="submit"], button:not([type])').first();
        if ((await submit.count()) > 0 && (await submit.isVisible()) && (await submit.isEnabled())) {
          const termsBeforeSubmit = await handleRequiredAgreementCheckboxes(input);
          if (!termsBeforeSubmit.active) return { recognized: true, advanced: false };
          const submittedByClick = await safeCrawlerClick(submit, 'form submit control');
          if (submittedByClick && await waitForFormAdvancement(beforeSignature)) return { recognized: true, advanced: true };
          if (fieldType === 'email' && await retryWithNextEmailIfNeeded(input)) {
            return await handleGenericFormInput(await inspectPageNavigationSafe('email collision retry'));
          }
        }
        const submitted = await input.evaluate(el => {
          const formEl = el.closest('form');
          if (!formEl) return false;
          formEl.requestSubmit();
          return true;
        });
        if (submitted && await waitForFormAdvancement(beforeSignature)) return { recognized: true, advanced: true };
        if (fieldType === 'email' && await retryWithNextEmailIfNeeded(input)) {
          return await handleGenericFormInput(await inspectPageNavigationSafe('email collision retry'));
        }
      }
      const nearbyAction = await findBottomPrimaryFormAction(input);
      if (nearbyAction) {
        const termsBeforeNearbyAction = await handleRequiredAgreementCheckboxes(input);
        if (!termsBeforeNearbyAction.active) return { recognized: true, advanced: false };
        const clicked = await safeCrawlerClick(nearbyAction.locator, nearbyAction.text || 'bottom primary CTA');
        if (clicked && await waitForFormAdvancement(beforeSignature)) return { recognized: true, advanced: true };
        if (fieldType === 'email' && await retryWithNextEmailIfNeeded(input)) {
          return await handleGenericFormInput(await inspectPageNavigationSafe('email collision retry'));
        }
      }

      // Some email-gate pages use a branded action such as GET MY PLAN / SEND MY PLAN
      // instead of a generic Continue button and place it outside the input's form.
      // Treat these as explicit email submission CTAs after the field is valid and
      // optional marketing consent has been kept off.
      if (fieldType === 'email') {
        const planAction = page.getByRole('button', { name: /^(get|send|show|unlock|email)\s+(me\s+)?(my\s+)?plan!?$/i }).first();
        const planLink = page.getByRole('link', { name: /^(get|send|show|unlock|email)\s+(me\s+)?(my\s+)?plan!?$/i }).first();
        let planTarget = null;
        if ((await planAction.count()) > 0 && await planAction.isVisible().catch(() => false) && await planAction.isEnabled().catch(() => false)) planTarget = planAction;
        else if ((await planLink.count()) > 0 && await planLink.isVisible().catch(() => false)) planTarget = planLink;
        if (planTarget) {
          console.log('Email-plan submission CTA detected.');
          const agreementBeforePlan = await handleRequiredAgreementCheckboxes(input);
          if (!agreementBeforePlan.active) return { recognized: true, advanced: false };
          const clicked = await safeCrawlerClick(planTarget, 'email plan submission CTA');
          if (clicked && await waitForFormAdvancement(beforeSignature, 12000)) return { recognized: true, advanced: true };
          if (await retryWithNextEmailIfNeeded(input)) {
            return await handleGenericFormInput(await inspectPageNavigationSafe('email collision retry'));
          }
        }
      }
      const termsBeforeEnter = await handleRequiredAgreementCheckboxes(input);
      if (!termsBeforeEnter.active) return { recognized: true, advanced: false };
      console.log(`Trying Enter for ${fieldType} input.`);
      await input.press('Enter');
      if (await waitForFormAdvancement(beforeSignature)) return { recognized: true, advanced: true };
      if (fieldType === 'email' && await retryWithNextEmailIfNeeded(input)) {
        return await handleGenericFormInput(await inspectPageNavigationSafe('email collision retry'));
      }
      console.log(`Unable to safely submit ${fieldType} field.`);
      return { recognized: true, advanced: false };
    }
    return { recognized: false, advanced: false };
  }

  async function isLikelyBranchTransition(state, questionState = null) {
    if (!state) return false;
    if (isNativeLanguageQuestion(state.pageText)) return false;
    if (await hasVisibleEditableInput()) return false;

    const normalized = (state.pageText || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const questionish = /\b(select all that apply|choose all that apply|select one|choose one|pick one|choose\s+\d+|select\s+\d+|pick\s+\d+|which|what(?:'s| is| are| do| would)|how (?:often|do|would|well|much)|tell us|tell me)\b/i.test(normalized);
    const hasMultipleAnswerLikeChoices = state.group.length >= 2 && questionish;
    if (hasMultipleAnswerLikeChoices) return false;

    if (questionState) {
      const before = normalizeContextText(questionState.pageText || '');
      const after = normalizeContextText(state.pageText || '');
      if (before && after && contextSimilarity(before, after) >= 0.92) return false;
    }

    // Informational/conditional screens may contain cards or a Continue CTA that
    // superficially look interactive. If the page no longer reads like a question,
    // treat it as a transition candidate even when a weak answer group was inferred.
    return true;
  }

  async function inspectPageNavigationSafe(label = 'page inspection', attempts = 4) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await inspectPage();
      } catch (error) {
        lastError = error;
        const message = String(error?.message || error || '');
        const navigationRace = /execution context was destroyed|cannot find context|most likely because of a navigation|frame was detached/i.test(message);
        if (!navigationRace || attempt === attempts) throw error;
        console.log(`Navigation was still settling during ${label}. Waiting before retry ${attempt + 1}/${attempts}.`);
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(350 * attempt);
      }
    }
    throw lastError;
  }

  async function evaluateNavigationSafe(pageFunction, label = 'page evaluation', attempts = 4) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await page.evaluate(pageFunction);
      } catch (error) {
        lastError = error;
        const message = String(error?.message || error || '');
        const navigationRace = /execution context was destroyed|cannot find context|most likely because of a navigation|frame was detached/i.test(message);
        if (!navigationRace || attempt === attempts) throw error;
        console.log(`Navigation was still settling during ${label}. Waiting before retry ${attempt + 1}/${attempts}.`);
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(350 * attempt);
      }
    }
    throw lastError;
  }

  async function screenshotBufferNavigationSafe(label = 'branch screenshot', attempts = 4) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await page.screenshot({ fullPage: true });
      } catch (error) {
        lastError = error;
        const message = String(error?.message || error || '');
        const navigationRace = /execution context was destroyed|cannot find context|most likely because of a navigation|frame was detached|navigation/i.test(message);
        if (!navigationRace || attempt === attempts) throw error;
        console.log(`Navigation was still settling during ${label}. Waiting before retry ${attempt + 1}/${attempts}.`);
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(350 * attempt);
      }
    }
    throw lastError;
  }

  async function restoreQuestionPage(questionUrl, expectedOptions, expectedQuestionFingerprint = '') {
    const expected = expectedOptions.map(x => (x || '').trim().toLowerCase()).filter(Boolean);
    const matchesQuestion = state => {
      if (!state || state.group.length < 2) return false;
      const current = state.group.map(x => (x.text || '').trim().toLowerCase());
      const overlap = expected.filter(text => current.includes(text)).length;
      const optionsMatch = overlap >= Math.min(2, expected.length);
      if (!optionsMatch) return false;

      if (!expectedQuestionFingerprint) return true;
      const currentPrompt = questionPromptFingerprint(state);
      if (!currentPrompt) return false;
      return contextSimilarity(expectedQuestionFingerprint, currentPrompt) >= 0.86;
    };

    const inspectAndMatch = async (waitMs = 700) => {
      await page.waitForTimeout(waitMs);
      await silenceMedia();
      const state = await inspectPageNavigationSafe('branch restore verification');
      return matchesQuestion(state) ? state : null;
    };

    // If we are already back on the question, do nothing. This is important for
    // branch probing because the first answer must always use the untouched page.
    const currentState = await inspectPageNavigationSafe('branch restore pre-check').catch(() => null);
    if (matchesQuestion(currentState)) return currentState;

    // Prefer the funnel's own visible Back control. Many onboarding SPAs keep every
    // step on one URL and manage state internally, so browser history is not a
    // reliable way to return from a transition screen to its source question.
    // Retry the funnel-native control a few times because some funnels insert more
    // than one informational screen between an answer and its source question.
    try {
      for (let nativeBackAttempt = 1; nativeBackAttempt <= 3; nativeBackAttempt++) {
        const beforeBackState = await inspectPageNavigationSafe('native back pre-check').catch(() => null);
        const beforeBackSignature = beforeBackState ? pageSignature(beforeBackState) : '';

        const backCandidate = await evaluateNavigationSafe(() => {
          const selectors = 'button, [role="button"], a, [onclick], [tabindex]';
          const elements = Array.from(document.querySelectorAll(selectors));
          const visible = el => {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
              r.top < window.innerHeight && r.left < window.innerWidth &&
              st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0 &&
              st.pointerEvents !== 'none';
          };
          const candidates = [];

          for (const el of elements) {
            if (!visible(el)) continue;
            const r = el.getBoundingClientRect();
            const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
            const aria = (el.getAttribute('aria-label') || '').trim();
            const title = (el.getAttribute('title') || '').trim();
            const rel = (el.getAttribute('rel') || '').trim();
            const combined = `${text} ${aria} ${title} ${rel}`.toLowerCase();
            const semanticBack = /(^|\s)(back|go back|previous|prev|geri|zuruck|zurück|retour|atras|atrás)(\s|$)/i.test(combined);
            const topLeftIcon = r.left <= Math.max(105, window.innerWidth * 0.24) &&
              r.top <= Math.max(140, window.innerHeight * 0.18) &&
              r.width <= 110 && r.height <= 110 &&
              !!el.querySelector('svg, img');
            if (!semanticBack && !topLeftIcon) continue;

            const cx = Math.max(0, Math.min(window.innerWidth - 1, r.left + r.width / 2));
            const cy = Math.max(0, Math.min(window.innerHeight - 1, r.top + r.height / 2));
            const top = document.elementFromPoint(cx, cy);
            const reachable = !!top && (top === el || el.contains(top) || top.contains(el));
            if (!reachable) continue;

            let id = el.getAttribute('data-auto-id');
            if (!id) {
              id = `crawler-back-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
              el.setAttribute('data-auto-id', id);
            }
            candidates.push({ id, semanticBack, topLeftIcon, top: r.top, left: r.left });
          }

          candidates.sort((a, b) => {
            if (a.semanticBack !== b.semanticBack) return a.semanticBack ? -1 : 1;
            if (a.topLeftIcon !== b.topLeftIcon) return a.topLeftIcon ? -1 : 1;
            if (a.top !== b.top) return a.top - b.top;
            return a.left - b.left;
          });
          return candidates[0] || null;
        });

        if (!backCandidate?.id) break;
        console.log(`Restoring branch question with the funnel's own Back control (attempt ${nativeBackAttempt}/3).`);
        const clicked = await safeCrawlerClick(
          page.locator(`[data-auto-id="${backCandidate.id}"]`),
          'funnel Back control'
        );
        if (!clicked) break;

        await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(450);
        const matched = await inspectAndMatch(500);
        if (matched) return matched;

        const afterBackState = await inspectPageNavigationSafe('native back post-check').catch(() => null);
        if (!afterBackState || (beforeBackSignature && pageSignature(afterBackState) === beforeBackSignature)) {
          console.log('Native Back control did not change the page; stopping native back retries.');
          break;
        }
      }
    } catch {}

    // Browser history remains a secondary fallback for funnels that create a real
    // history entry between the question and its transition page.
    try {
      console.log('Funnel Back control did not restore the question. Trying browser history once.');
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
      const matched = await inspectAndMatch(900);
      if (matched) return matched;
    } catch {}

    // Never reload the saved question URL on the live SPA session. Many funnels
    // keep progress outside the URL; page.goto(questionUrl) can silently restart
    // onboarding from page 1 even when the URL is unchanged.
    console.log('Browser history did not restore the question. Direct URL restoration is disabled in forward-only safety mode.');
    console.log('Unable to restore the exact original branch question safely.');
    return null;
  }

  async function chooseBranchOptionAndAdvance(optionText, screenNumber, questionState) {
    let state = await inspectPageNavigationSafe('branch answer inspection');
    const wanted = (optionText || '').trim().toLowerCase();
    let option = state.group.find(x => (x.text || '').trim().toLowerCase() === wanted);
    if (!option) option = state.group.find(x => (x.text || '').trim().toLowerCase().includes(wanted));
    if (!option) return { advanced: false, landingState: null };

    const questionUrl = page.url();
    const before = pageSignature(state);
    const clicked = await safeCrawlerClick(page.locator(`[data-auto-id="${option.id}"]`), option.text || 'branch answer');
    if (!clicked) return { advanced: false, landingState: null };
    await page.waitForTimeout(700);
    let after = await inspectPageNavigationSafe('branch answer inspection');

    // Some funnels update the next screen asynchronously after the answer click.
    // Poll briefly before treating a still-identical screen as an advance failure.
    if (pageSignature(after) === before) {
      const waitStarted = Date.now();
      while (Date.now() - waitStarted < 3500 && pageSignature(after) === before) {
        await page.waitForTimeout(350);
        after = await inspectPageNavigationSafe('branch answer inspection');
      }
    }

    if (sanitizeUrl(page.url()) === sanitizeUrl(questionUrl) && after.group.length > 0) {
      const beforeText = normalizeContextText(questionState?.pageText || state.pageText, [optionText]);
      const afterText = normalizeContextText(after.pageText, [optionText]);
      const originalOptions = (questionState?.group || state.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);
      const currentOptions = (after.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);
      const optionOverlap = originalOptions.filter(text => currentOptions.includes(text)).length;
      const optionsStillMatch = optionOverlap >= Math.max(1, Math.ceil(Math.min(originalOptions.length, currentOptions.length) * 0.5));
      const originalPrompt = questionPromptFingerprint(questionState || state);
      const currentPrompt = questionPromptFingerprint(after);
      const promptStillMatches = !!originalPrompt && !!currentPrompt && contextSimilarity(originalPrompt, currentPrompt) >= 0.86;
      const sameQuestionStillVisible = optionsStillMatch && promptStillMatches;

      // A large number of onboarding funnels are SPAs: clicking an answer replaces
      // the current question with the next question without changing the URL. If
      // the prompt/answer set no longer matches the original question, that is real
      // advancement and must be returned as the branch landing state. Previously we
      // fell through and reported advance-failed simply because another answer group
      // was already visible on the same URL.
      if (!sameQuestionStillVisible && pageSignature(after) !== before) {
        await waitForScreenshotReady();
        return {
          advanced: true,
          landingState: await inspectPageNavigationSafe('same-URL next-question branch landing')
        };
      }

      if (sameQuestionStillVisible && afterText && beforeText !== afterText) {
        await captureSupplementalState(
          screenNumber,
          after,
          `post-selection response for "${optionText}"`,
          [optionText],
          0.95
        );
      }
      if (after.cta) {
        const beforeCTA = pageSignature(after);
        const ctaClicked = await safeCrawlerClick(page.locator(`[data-auto-id="${after.cta.id}"]`), after.cta.text || 'branch CTA');
        if (ctaClicked && await waitForAdvancement(beforeCTA, 12000)) {
          await waitForScreenshotReady();
          return { advanced: true, landingState: await inspectPageNavigationSafe('branch answer inspection') };
        }
      }
      return { advanced: false, landingState: after };
    }

    if (pageSignature(after) !== before) {
      await waitForScreenshotReady();
      return { advanced: true, landingState: await inspectPageNavigationSafe('branch answer inspection') };
    }

    if (after.cta) {
      const beforeCTA = pageSignature(after);
      const ctaClicked = await safeCrawlerClick(page.locator(`[data-auto-id="${after.cta.id}"]`), after.cta.text || 'branch CTA');
      if (ctaClicked && await waitForAdvancement(beforeCTA, 12000)) {
        await waitForScreenshotReady();
        return { advanced: true, landingState: await inspectPageNavigationSafe('branch answer inspection') };
      }
    }

    after = await inspectPageNavigationSafe('branch answer inspection');
    return { advanced: pageSignature(after) !== before, landingState: after };
  }

  async function answerGroupIsInsideActiveModal(state) {
    if (!state?.group?.length) return false;
    return await page.evaluate((ids) => {
      const dialogSelector = '[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="popup" i], [class*="overlay" i], [class*="sheet" i]';
      const visible = el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
          r.top < window.innerHeight && r.left < window.innerWidth &&
          s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
      };
      let inside = 0;
      for (const id of ids) {
        const el = document.querySelector(`[data-auto-id="${CSS.escape(id)}"]`);
        if (el && el.closest(dialogSelector) && visible(el.closest(dialogSelector))) inside++;
      }
      return inside >= Math.ceil(ids.length * 0.6);
    }, state.group.map(x => x.id)).catch(() => false);
  }

  async function advancePastCapturedTransition(state) {
    if (!state) return false;

    const strong = await clickStrongNavigation(state, 'captured conditional transition CTA');
    if (strong.handled) return strong.advanced;

    const refreshed = await inspectPage();
    if (refreshed.cta) {
      const before = pageSignature(refreshed);
      const clicked = await safeCrawlerClick(
        page.locator(`[data-auto-id="${refreshed.cta.id}"]`),
        refreshed.cta.text || 'captured conditional transition CTA'
      );
      if (clicked && await waitForAdvancement(before, 12000)) return true;
    }

    const delayed = await waitForActionableState(12000);
    if (delayed?.changed) return true;
    return false;
  }

  function branchOutcomeEquivalent(a, b) {
    if (!a || !b) return false;

    if (a.screenshotBuffer && b.screenshotBuffer &&
        Buffer.isBuffer(a.screenshotBuffer) && Buffer.isBuffer(b.screenshotBuffer) &&
        a.screenshotBuffer.equals(b.screenshotBuffer)) {
      return true;
    }

    const textA = a.fingerprint || normalizeContextText(a.landingState?.pageText || '');
    const textB = b.fingerprint || normalizeContextText(b.landingState?.pageText || '');
    if (!textA || !textB) return false;

    const similarity = contextSimilarity(textA, textB);
    if (similarity >= 0.985) return true;

    const numericClaims = text => (text.match(/\b\d+(?:[.,]\d+)?%?\b/g) || []).join('|');
    if (similarity >= 0.955 && numericClaims(textA) === numericClaims(textB)) return true;

    return false;
  }

  function uniqueBranchOutcomeGroups(outcomes) {
    const groups = [];
    for (const outcome of outcomes) {
      let group = groups.find(item => branchOutcomeEquivalent(item, outcome));
      if (!group) {
        group = { ...outcome, answers: [], answerSets: [] };
        groups.push(group);
      }
      if (outcome.optionText) group.answers.push(outcome.optionText);
      if (outcome.answers) group.answerSets.push(outcome.answers);
    }
    return groups;
  }

  function branchProbeIndexes(optionCount, maxProbe = 4) {
    const indexes = Array.from({ length: optionCount }, (_, i) => i);
    for (let i = indexes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
    }
    return indexes.slice(0, Math.min(maxProbe, optionCount));
  }

  async function chooseMultiSelectSetAndAdvance(answerTexts, screenNumber, questionState) {
    let state = await inspectPageNavigationSafe('multi-select branch inspection');
    const before = pageSignature(state);
    const questionUrl = sanitizeUrl(page.url());
    const selected = [];

    for (const wantedText of answerTexts) {
      state = await inspectPageNavigationSafe('multi-select option inspection');
      const uniqueGroup = uniqueAnswerOptions(state.group);
      const wanted = canonicalAnswerText(wantedText);
      let option = uniqueGroup.find(x => canonicalAnswerText(x.text) === wanted);
      if (!option) option = uniqueGroup.find(x => canonicalAnswerText(x.text).includes(wanted));
      if (!option) return { advanced: false, landingState: state, reason: 'option-missing' };

      const clicked = await safeCrawlerClick(
        page.locator(`[data-auto-id="${option.id}"]`),
        option.text || 'multi-select branch answer'
      );
      if (!clicked) return { advanced: false, landingState: state, reason: 'click-failed' };
      selected.push(option.text || wantedText);

      const afterSelection = await waitForPostSelectionSettle('multi-select post-selection inspection', 2600, 7000);
      const originalPrompt = questionPromptFingerprint(questionState);
      const currentPrompt = questionPromptFingerprint(afterSelection);
      const samePrompt = !!originalPrompt && !!currentPrompt && contextSimilarity(originalPrompt, currentPrompt) >= 0.86;
      const originalOptions = (questionState.group || []).map(x => canonicalAnswerText(x.text)).filter(Boolean);
      const currentOptions = (afterSelection.group || []).map(x => canonicalAnswerText(x.text)).filter(Boolean);
      const overlap = originalOptions.filter(text => currentOptions.includes(text)).length;
      const sameAnswerSet = overlap >= Math.max(1, Math.ceil(Math.min(originalOptions.length, currentOptions.length) * 0.6));
      if (sanitizeUrl(page.url()) === questionUrl && samePrompt && sameAnswerSet && !isTransientPostSelectionShell(afterSelection)) {
        await captureSamePageVisualVariant(screenNumber, `selection: ${selected.join(' + ')}`);
      }
      if (sanitizeUrl(page.url()) !== questionUrl || (!samePrompt && pageSignature(afterSelection) !== before)) {
        await waitForScreenshotReady();
        return { advanced: true, landingState: afterSelection, selected };
      }
    }

    state = await inspectPageNavigationSafe('multi-select pre-submit inspection');
    if (state.cta) {
      const beforeCTA = pageSignature(state);
      const clicked = await safeCrawlerClick(
        page.locator(`[data-auto-id="${state.cta.id}"]`),
        state.cta.text || 'multi-select branch CTA'
      );
      if (clicked && await waitForAdvancement(beforeCTA, 12000)) {
        await waitForScreenshotReady();
        return {
          advanced: true,
          landingState: await inspectPageNavigationSafe('multi-select branch landing'),
          selected
        };
      }
    }

    const nav = await clickStrongNavigation(state, 'multi-select branch CTA');
    if (nav.handled && nav.advanced) {
      await waitForScreenshotReady();
      return {
        advanced: true,
        landingState: await inspectPageNavigationSafe('multi-select branch landing'),
        selected
      };
    }

    return { advanced: false, landingState: state, reason: 'submit-failed', selected };
  }

  function canonicalAnswerText(text) {
    return (text || '')
      .toLowerCase()
      .replace(/[✓✔☑✅]/g, ' ')
      .replace(/\b(?:selected|checked)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function answerTextLooksSelected(text) {
    return /[✓✔☑✅]/.test(text || '');
  }

  async function clearPersistedMultiSelectSelections(questionState) {
    // Some SPAs return to the same question but keep earlier answers checked.
    // Branch comparisons must be independent, so clear only controls with explicit
    // selected state before testing the next answer set.
    for (let pass = 0; pass < 12; pass++) {
      const currentState = await inspectPageNavigationSafe('multi-select selection reset').catch(() => null);
      if (!currentState || !sameQuestionIgnoringSelectionVisuals(questionState, currentState)) return false;
      const options = uniqueAnswerOptions(currentState.group || []);
      let selectedOption = null;
      for (const option of options) {
        const locator = page.locator(`[data-auto-id="${option.id}"]`);
        const domSelected = await locator.evaluate(el => {
          const truthy = value => ['true', 'checked', 'selected', 'on'].includes((value || '').toLowerCase());
          if (truthy(el.getAttribute('aria-checked')) || truthy(el.getAttribute('aria-selected')) || truthy(el.getAttribute('data-state'))) return true;
          if (el.matches('input:checked')) return true;
          if (el.querySelector('input:checked, [aria-checked="true"], [aria-selected="true"], [data-state="checked"], [data-state="selected"]')) return true;
          return false;
        }).catch(() => false);
        if (domSelected || answerTextLooksSelected(option.text || '')) {
          selectedOption = option;
          break;
        }
      }
      if (!selectedOption) {
        if (pass > 0) console.log('Cleared persisted multi-select selections before the next independent branch test.');
        return true;
      }
      const clicked = await safeCrawlerClick(
        page.locator(`[data-auto-id="${selectedOption.id}"]`),
        `clear persisted multi-select selection ${selectedOption.text || ''}`
      );
      if (!clicked) return false;
      await page.waitForTimeout(300);
    }
    return false;
  }

  function sameQuestionIgnoringSelectionVisuals(originalState, currentState) {
    if (!originalState || !currentState) return false;
    const originalPrompt = questionPromptFingerprint(originalState);
    const currentPrompt = questionPromptFingerprint(currentState);
    if (!originalPrompt || !currentPrompt || contextSimilarity(originalPrompt, currentPrompt) < 0.82) return false;
    const originalOptions = uniqueAnswerOptions(originalState.group || []).map(x => canonicalAnswerText(x.text)).filter(Boolean);
    const currentOptions = uniqueAnswerOptions(currentState.group || []).map(x => canonicalAnswerText(x.text)).filter(Boolean);
    if (originalOptions.length < 2 || currentOptions.length < 2) return false;
    const overlap = originalOptions.filter(text => currentOptions.includes(text)).length;
    return overlap >= Math.max(2, Math.ceil(Math.min(originalOptions.length, currentOptions.length) * 0.7));
  }

  async function exploreMultiSelectBranches(state, screenNumber, instruction) {
    const uniqueOptions = uniqueAnswerOptions(state.group);
    const optionTexts = uniqueOptions.map(x => (x.text || '').trim()).filter(Boolean);
    if (optionTexts.length < 2 || optionTexts.length > 10) return false;

    const minSelections = Math.max(1, Math.min(instruction.minSelections || 1, optionTexts.length));
    const questionUrl = page.url();
    const questionFingerprint = questionPromptFingerprint(state);
    const outcomes = [];

    const testSets = [];
    if (minSelections === 1) {
      for (const text of optionTexts) testSets.push([text]);
    } else {
      const baseline = optionTexts.slice(0, minSelections);
      testSets.push(baseline);
      for (let i = minSelections; i < optionTexts.length; i++) {
        const variant = baseline.slice();
        variant[variant.length - 1] = optionTexts[i];
        testSets.push(variant);
      }
    }

    console.log(`Multi-select branch candidate detected. Testing ${testSets.length} bounded selection set(s) for conditional next pages.`);

    for (let setIndex = 0; setIndex < testSets.length; setIndex++) {
      if (setIndex > 0) {
        let restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
        if (!restored) {
          const currentState = await inspectPageNavigationSafe('multi-select restore-failure identity check').catch(() => null);
          if (sameQuestionIgnoringSelectionVisuals(state, currentState)) {
            console.log('Restore verification was strict, but this is still the same multi-select question with remembered selection styling. Reusing it as the source question.');
            restored = currentState;
          } else {
            console.log('Multi-select branch question could not be restored. Preserving the current landing page for the next numbered screenshot instead of interacting with it before capture.');
            return true;
          }
        }
        const cleared = await clearPersistedMultiSelectSelections(state);
        if (!cleared) {
          console.log('Could not reliably clear persisted multi-select selections. Stopping branch comparison rather than testing cumulative answer sets or creating duplicate numbered pages.');
          return false;
        }
      }

      const result = await chooseMultiSelectSetAndAdvance(testSets[setIndex], screenNumber, state);
      if (!result.advanced || !result.landingState) {
        console.log(`Could not safely test multi-select set: ${testSets[setIndex].join(' + ')}`);
        continue;
      }

      await waitForScreenshotReady({ minimumWaitMs: 1800, maxWaitMs: 5200 });
      const landingState = await inspectPageNavigationSafe('multi-select branch outcome inspection');
      const fingerprint = normalizeContextText(landingState.pageText);
      if (!fingerprint) continue;
      const screenshotBuffer = await screenshotBufferNavigationSafe('multi-select branch outcome screenshot');
      const affinity = answerOutcomeAffinity(testSets[setIndex], landingState.pageText);
      outcomes.push({ answers: testSets[setIndex], fingerprint, screenshotBuffer, landingState, affinity });
      console.log(`Recorded multi-select next-page outcome for: ${testSets[setIndex].join(' + ')}`);
      if (affinity.connected) {
        console.log(`Contextual branch evidence: the landing page echoes the selected answer(s): ${affinity.hits.map(hit => `${hit.answer} -> ${hit.matched.join(', ')}`).join(' | ')}. Treating this as a likely answer-dependent transition and verifying the other choices.`);
      }
    }

    if (outcomes.length < 2) {
      if (outcomes.length === 1) {
        console.log('Only one multi-select outcome could be recorded. Keeping that landing page untouched so it will be captured as the next numbered screenshot.');
        return true;
      }
      return false;
    }

    const uniqueOutcomes = uniqueBranchOutcomeGroups(outcomes);

    if (uniqueOutcomes.length > 1) {
      console.log(`Conditional multi-select branching confirmed: ${uniqueOutcomes.length} unique next pages found.`);
      for (let i = 0; i < uniqueOutcomes.length; i++) {
        const filename = nextFreeLetteredFilename(screenNumber);
        if (!filename) continue;
        fs.writeFileSync(filename, uniqueOutcomes[i].screenshotBuffer);
        console.log(`Captured ${path.basename(filename)} for selection set(s): ${uniqueOutcomes[i].answerSets.map(set => set.join(' + ')).join(' | ')}`);
      }
    } else {
      console.log('All tested multi-select selection sets led to the same immediate next page.');
    }

    const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
    if (!restored) {
      const currentState = await inspectPageNavigationSafe('multi-select final restore identity check').catch(() => null);
      if (sameQuestionIgnoringSelectionVisuals(state, currentState)) {
        console.log('The multi-select source question is still the same page despite remembered selection styling. It will not receive a new numbered screenshot.');
        await clearPersistedMultiSelectSelections(state).catch(() => false);
        return false;
      }
      console.log('Could not restore the multi-select source question after comparison. Preserving the current landing page for the next numbered screenshot.');
      return true;
    }

    const finalResult = await chooseMultiSelectSetAndAdvance(testSets[0], screenNumber, state);
    if (!finalResult.advanced || !finalResult.landingState) return false;
    if (uniqueOutcomes.length > 1) {
      const mainFingerprint = normalizeContextText(finalResult.landingState.pageText);
      if (uniqueOutcomes.some(item => item.fingerprint === mainFingerprint)) {
        skipNextNumberedFingerprint = mainFingerprint;
        console.log('Main path is on a multi-select transition already captured as a lettered screenshot; the duplicate numbered transition will be skipped.');
      }
    }
    return true;
  }

  async function inspectIsolatedBranchPage(probePage) {
    return await probePage.evaluate(() => {
      const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
      const visible = el => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
          r.top < window.innerHeight && r.left < window.innerWidth &&
          st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0;
      };
      const nav = /^(?:continue|next|proceed|submit|done|finish|start|see results?|get started|go on|keep going|move on|skip|not now|back|previous)$/i;
      const selectors = 'button, a, label, [role="button"], [role="radio"], [role="option"], [role="checkbox"], [onclick], [tabindex]';
      const seen = new Set();
      const group = [];
      for (const el of Array.from(document.querySelectorAll(selectors))) {
        if (!visible(el)) continue;
        const text = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
        if (!text || text.length > 180 || nav.test(text)) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        group.push({ text });
      }
      return {
        pageText: normalize(document.body && document.body.innerText || ''),
        group,
        url: location.href
      };
    });
  }

  async function markIsolatedBranchOption(probePage, optionText) {
    return await probePage.evaluate(wantedText => {
      const normalize = value => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const wanted = normalize(wantedText);
      const visible = el => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
          st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0 &&
          st.pointerEvents !== 'none';
      };
      const clickable = el => {
        const st = getComputedStyle(el);
        const role = el.getAttribute('role');
        return ['BUTTON', 'A', 'LABEL'].includes(el.tagName) ||
          ['button', 'radio', 'option', 'checkbox'].includes(role || '') ||
          el.hasAttribute('onclick') || el.tabIndex >= 0 || st.cursor === 'pointer';
      };
      const matches = [];
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        if (!visible(el)) continue;
        const text = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
        if (text !== wanted) continue;
        const r = el.getBoundingClientRect();
        matches.push({ el, area: r.width * r.height });
      }
      matches.sort((a, b) => a.area - b.area);
      for (const item of matches) {
        let target = item.el;
        for (let depth = 0; target && target !== document.body && depth < 6; depth++, target = target.parentElement) {
          if (!visible(target) || !clickable(target)) continue;
          const id = 'crawler-isolated-branch-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
          target.setAttribute('data-crawler-isolated-branch-id', id);
          target.scrollIntoView({ block: 'center', inline: 'center' });
          return id;
        }
      }
      return null;
    }, optionText).catch(() => null);
  }

  async function clickIsolatedNavigation(probePage) {
    const id = await probePage.evaluate(() => {
      const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
      const strong = /^(?:continue|next|proceed|submit|done|finish|start|see results?|get started|go on|keep going|move on)$/i;
      const visible = el => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
          r.top < window.innerHeight && r.left < window.innerWidth &&
          st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0 &&
          st.pointerEvents !== 'none';
      };
      const candidates = [];
      for (const el of Array.from(document.querySelectorAll('button, a, [role="button"], [onclick], [tabindex]'))) {
        if (!visible(el)) continue;
        const text = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
        if (!strong.test(text)) continue;
        const r = el.getBoundingClientRect();
        candidates.push({ el, top: r.top, area: r.width * r.height });
      }
      candidates.sort((a, b) => b.top - a.top || b.area - a.area);
      if (!candidates.length) return null;
      const target = candidates[0].el;
      const id = 'crawler-isolated-nav-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
      target.setAttribute('data-crawler-isolated-nav-id', id);
      target.scrollIntoView({ block: 'center', inline: 'center' });
      return id;
    }).catch(() => null);
    if (!id) return false;
    return await probePage.locator('[data-crawler-isolated-nav-id="' + id + '"]')
      .click({ timeout: 6000 }).then(() => true).catch(() => false);
  }

  async function createIsolatedBranchCheckpoint(questionState) {
    const context = page.context();
    let storageState;
    try {
      storageState = await context.storageState({ indexedDB: true });
    } catch {
      storageState = await context.storageState();
    }
    const session = await page.evaluate(() => ({
      origin: location.origin,
      entries: Object.entries(sessionStorage)
    })).catch(() => ({ origin: '', entries: [] }));
    return {
      url: page.url(),
      storageState,
      session,
      questionFingerprint: questionPromptFingerprint(questionState),
      optionTexts: uniqueAnswerOptions(questionState.group).map(x => (x.text || '').trim()).filter(Boolean)
    };
  }

  async function probeIsolatedBranchOption(checkpoint, optionText) {
    const probeContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      storageState: checkpoint.storageState
    });
    try {
      const probePage = await probeContext.newPage();
      if (checkpoint.session && checkpoint.session.origin) {
        await probePage.addInitScript(data => {
          try {
            if (location.origin !== data.origin) return;
            for (const entry of data.entries || []) sessionStorage.setItem(entry[0], entry[1]);
          } catch {}
        }, checkpoint.session);
      }

      await probePage.goto(checkpoint.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await probePage.waitForTimeout(1100);

      const sourceState = await inspectIsolatedBranchPage(probePage);
      const sourceOptions = (sourceState.group || []).map(x => canonicalAnswerText(x.text)).filter(Boolean);
      const expectedOptions = checkpoint.optionTexts.map(canonicalAnswerText);
      const overlap = expectedOptions.filter(text => sourceOptions.includes(text)).length;
      const sourceFingerprint = questionPromptFingerprint(sourceState);
      const promptMatch = checkpoint.questionFingerprint && sourceFingerprint
        ? contextSimilarity(checkpoint.questionFingerprint, sourceFingerprint) >= 0.78
        : true;
      if (overlap < Math.min(2, expectedOptions.length) || !promptMatch) {
        return { ok: false, reason: 'checkpoint did not reopen the same source question' };
      }

      const beforeFingerprint = normalizeContextText(sourceState.pageText || '');
      const beforeUrl = sanitizeUrl(sourceState.url || checkpoint.url);
      const optionId = await markIsolatedBranchOption(probePage, optionText);
      if (!optionId) return { ok: false, reason: 'option not found in isolated copy' };

      const clicked = await probePage.locator('[data-crawler-isolated-branch-id="' + optionId + '"]')
        .click({ timeout: 7000 }).then(() => true).catch(() => false);
      if (!clicked) return { ok: false, reason: 'isolated option click failed' };

      await probePage.waitForTimeout(900);
      let landingState = await inspectIsolatedBranchPage(probePage);

      const stillSource = stateNow => {
        const currentOptions = (stateNow.group || []).map(x => canonicalAnswerText(x.text)).filter(Boolean);
        const optionOverlap = expectedOptions.filter(text => currentOptions.includes(text)).length;
        const currentPrompt = questionPromptFingerprint(stateNow);
        const samePrompt = checkpoint.questionFingerprint && currentPrompt
          ? contextSimilarity(checkpoint.questionFingerprint, currentPrompt) >= 0.84
          : false;
        const sameText = normalizeContextText(stateNow.pageText || '') === beforeFingerprint;
        const sameUrl = sanitizeUrl(stateNow.url || '') === beforeUrl;
        return sameUrl && (sameText || (samePrompt && optionOverlap >= Math.min(2, expectedOptions.length)));
      };

      if (stillSource(landingState)) {
        const navClicked = await clickIsolatedNavigation(probePage);
        if (navClicked) {
          await probePage.waitForTimeout(1000);
          landingState = await inspectIsolatedBranchPage(probePage);
        }
      }

      const startedAt = Date.now();
      while (stillSource(landingState) && Date.now() - startedAt < 6000) {
        await probePage.waitForTimeout(500);
        landingState = await inspectIsolatedBranchPage(probePage);
      }
      if (stillSource(landingState)) return { ok: false, reason: 'isolated probe did not advance' };

      await probePage.waitForTimeout(1300);
      landingState = await inspectIsolatedBranchPage(probePage);
      const fingerprint = normalizeContextText(landingState.pageText || '');
      if (!fingerprint) return { ok: false, reason: 'isolated probe has no fingerprint' };
      const screenshotBuffer = await probePage.screenshot({ fullPage: true });

      return { ok: true, optionText, fingerprint, screenshotBuffer, landingState };
    } catch (error) {
      return { ok: false, reason: 'isolated probe error: ' + String(error && error.message || error).split('\n')[0] };
    } finally {
      await probeContext.close().catch(() => {});
    }
  }

  async function exploreAnswerBranchesIsolated(state, screenNumber) {
    if (await hasVisibleEditableInput()) {
      console.log('Forward-only branch mode: editable form detected. Skipping branch probing for form controls/consent links.');
      return false;
    }

    const instruction = getSelectionInstruction(state.pageText);
    if (instruction.minSelections !== 1 || (instruction.maxSelections !== null && instruction.maxSelections !== 1)) {
      console.log('Forward-only branch mode: multi-select branch probing is skipped; taking the normal path.');
      return false;
    }
    if (isNativeLanguageQuestion(state.pageText) || isNonBranchProfileQuestion(state.pageText)) return false;
    if (isSpeechInputScreen(state.pageText) || hasSkipEscapeChoice(state)) return false;
    if (await answerGroupIsInsideActiveModal(state)) return false;

    const optionTexts = uniqueAnswerOptions(state.group).map(x => (x.text || '').trim()).filter(Boolean);
    if (optionTexts.length < 2 || optionTexts.length > 10) return false;

    console.log('Forward-only branch mode: testing all ' + optionTexts.length + ' answers in isolated browser contexts. The live funnel will not move backward.');
    const checkpoint = await createIsolatedBranchCheckpoint(state);
    const outcomes = [];

    for (const optionText of optionTexts) {
      const outcome = await probeIsolatedBranchOption(checkpoint, optionText);
      if (!outcome.ok) {
        console.log('Isolated branch probe skipped for "' + optionText + '": ' + outcome.reason);
        continue;
      }
      outcomes.push(outcome);
      console.log('Isolated branch outcome recorded for "' + optionText + '".');
    }

    if (outcomes.length < 2) {
      console.log('Not enough isolated branch outcomes could be compared. Leaving the live funnel untouched and continuing normally.');
      return false;
    }

    const uniqueOutcomes = uniqueBranchOutcomeGroups(outcomes);
    if (uniqueOutcomes.length <= 1) {
      console.log('All successfully tested answers led to the same immediate next page. No conditional page detected.');
      return false;
    }

    console.log('Conditional branching confirmed safely: ' + uniqueOutcomes.length + ' distinct immediate next pages found without rewinding the live funnel.');

    const conditionalQuestionOutcomes = uniqueOutcomes.filter(item => (item.landingState && item.landingState.group && item.landingState.group.length || 0) >= 2);
    const conditionalTransitionOutcomes = uniqueOutcomes.filter(item => (item.landingState && item.landingState.group && item.landingState.group.length || 0) < 2);

    for (const outcome of conditionalTransitionOutcomes) {
      const filename = nextFreeLetteredFilename(screenNumber);
      if (!filename) continue;
      fs.writeFileSync(filename, outcome.screenshotBuffer);
      console.log('Captured ' + path.basename(filename) + ' conditional transition for answer(s): ' + (outcome.answers || []).join(' | '));
    }

    if (conditionalQuestionOutcomes.length > 1) {
      const canonicalQuestionOutcome =
        conditionalQuestionOutcomes.find(item => (item.answers || []).includes(optionTexts[0])) ||
        conditionalQuestionOutcomes[0];
      const alternateQuestionOutcomes = conditionalQuestionOutcomes.filter(item => item !== canonicalQuestionOutcome);
      console.log('Conditional next-question variants detected safely: ' + conditionalQuestionOutcomes.length + '. Saving ' + alternateQuestionOutcomes.length + ' alternate variant(s).');
      for (const outcome of alternateQuestionOutcomes) {
        const filename = nextFreeLetteredFilename(screenNumber + 1);
        if (!filename) continue;
        fs.writeFileSync(filename, outcome.screenshotBuffer);
        console.log('Captured ' + path.basename(filename) + ' conditional next-question variant for answer(s): ' + (outcome.answers || []).join(' | '));
      }
    }

    const canonicalTransition =
      conditionalTransitionOutcomes.find(item => (item.answers || []).includes(optionTexts[0])) || null;
    if (canonicalTransition) {
      skipNextNumberedFingerprint = canonicalTransition.fingerprint;
      console.log('The normal first-answer path is expected to land on a transition already captured above; its duplicate numbered screenshot will be skipped.');
    }

    return true;
  }

  async function exploreAnswerBranches(state, screenNumber) {
    const instruction = getSelectionInstruction(state.pageText);
    if (isNativeLanguageQuestion(state.pageText)) return false;
    if (isNonBranchProfileQuestion(state.pageText)) {
      console.log('Simple profile/setup question detected. Skipping branch exploration and taking a normal answer path.');
      return false;
    }
    if (isSpeechInputScreen(state.pageText) || hasSkipEscapeChoice(state)) {
      console.log('Skip/optional-input screen detected. Bypassing branch exploration so the escape action can be used.');
      return false;
    }
    if (await answerGroupIsInsideActiveModal(state)) {
      console.log('Answer group is inside an active modal/dialog. Treating it as a normal required choice, not a branch point.');
      return false;
    }
    if (state.group.length < 2 || state.group.length > 10) return false;

    // Multi-select questions can also drive conditional transitions.
    if (instruction.minSelections !== 1 || instruction.maxSelections !== 1) {
      return await exploreMultiSelectBranches(state, screenNumber, instruction);
    }

    const optionTexts = uniqueAnswerOptions(state.group).map(x => (x.text || '').trim()).filter(Boolean);
    if (optionTexts.length < 2) return false;

    const questionUrl = page.url();
    const questionState = state;
    const questionFingerprint = questionPromptFingerprint(questionState);
    const outcomes = [];
    const probedIndexes = branchProbeIndexes(optionTexts.length, 4);
    console.log(`Randomly probing up to ${probedIndexes.length} answers to determine whether this question has conditional next pages.`);

    const recordOutcomeForIndex = async (index) => {
      if (outcomes.length > 0) {
        const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
        if (!restored) return { ok: false, reason: 'restore-failed' };
      }
      const result = await chooseBranchOptionAndAdvance(optionTexts[index], screenNumber, questionState);
      if (!result.advanced || !result.landingState) return { ok: false, reason: 'advance-failed' };
      await waitForScreenshotReady({ minimumWaitMs: 2200, maxWaitMs: 5800 });
      const landingState = await inspectPageNavigationSafe('branch outcome inspection');
      const fingerprint = normalizeContextText(landingState.pageText);
      if (!fingerprint) return { ok: false, reason: 'no-fingerprint' };
      const screenshotBuffer = await screenshotBufferNavigationSafe('branch outcome screenshot');
      outcomes.push({ index, optionText: optionTexts[index], fingerprint, screenshotBuffer, landingState });
      console.log(`Recorded immediate next-page outcome for "${optionTexts[index]}".`);
      return { ok: true };
    };

    const failedProbeIndexes = [];
    for (const index of probedIndexes) {
      const recorded = await recordOutcomeForIndex(index);
      if (!recorded.ok) {
        failedProbeIndexes.push(index);
        console.log(`Could not safely compare branch outcome for "${optionTexts[index]}": ${recorded.reason}. Keeping the successful outcomes and continuing.`);
      }
    }

    // If fewer than two answers could be tested, do not hand a half-restored page
    // back to the generic answer handler. Restore the original question and take
    // the normal first-answer path here, inside the branch system.
    if (outcomes.length < 2) {
      console.log('Too few branch outcomes were successfully tested. Restoring the question and continuing on the normal first-answer path.');
      const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
      if (!restored) {
        console.log('Branch source could not be restored. Preserving the current landing page for the next numbered screenshot.');
        return outcomes.length > 0;
      }
      const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
      return finalResult.advanced;
    }

    let probeFingerprints = new Set(uniqueBranchOutcomeGroups(outcomes).map((_, i) => String(i)));

    // A failed probe is unresolved evidence, not proof that there is no branch.
    // Retry only the failed answer(s), after the successful first attempts have
    // already been preserved. This does NOT restore before the first probe.
    if (failedProbeIndexes.length > 0) {
      for (const index of failedProbeIndexes) {
        console.log(`Retrying unresolved branch answer "${optionTexts[index]}" once from the restored question.`);
        const recorded = await recordOutcomeForIndex(index);
        if (!recorded.ok) {
          console.log(`Branch answer "${optionTexts[index]}" is still unresolved after retry. It will be skipped without aborting the crawl.`);
        }
      }
      probeFingerprints = new Set(uniqueBranchOutcomeGroups(outcomes).map((_, i) => String(i)));
    }

    let testedIndexes = new Set(outcomes.map(x => x.index));
    let unresolvedIndexes = probedIndexes.filter(index => !testedIndexes.has(index));

    // The four-answer sample is the decision stage. If all sampled answers lead to
    // the same immediate next page, do not test every unprobed answer just to prove
    // sameness. Untested answers remain unresolved and the normal path continues.
    // If the sample proves branching, the existing branch-confirmed path below can
    // still test remaining answers to collect distinct conditional pages.

    if (probeFingerprints.size <= 1 && unresolvedIndexes.length === 0) {
      console.log(`Branch comparison result: all ${outcomes.length} answers lead to the same immediate next page. No conditional branch detected.`);
      const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
      if (!restored) {
        console.log('Branch source could not be restored. Preserving the current landing page for the next numbered screenshot.');
        return outcomes.length > 0;
      }
      const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
      return finalResult.advanced;
    }

    if (probeFingerprints.size <= 1 && unresolvedIndexes.length > 0) {
      console.log('No different transition was proven, but at least one answer remains unresolved. The crawler will not claim that all answers are identical. Continuing on the normal path without conditional screenshots.');
      const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
      if (!restored) {
        console.log('Branch source could not be restored. Preserving the current landing page for the next numbered screenshot.');
        return outcomes.length > 0;
      }
      const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
      return finalResult.advanced;
    }

    console.log(`Conditional branching confirmed: ${probeFingerprints.size} different immediate next pages found.`);
    console.log('Branching is confirmed, so the crawler will now test every remaining unresolved answer to classify unique next-page variants.');

    const alreadyTested = new Set(outcomes.map(x => x.index));
    for (let index = 0; index < optionTexts.length; index++) {
      if (alreadyTested.has(index)) continue;
      const recorded = await recordOutcomeForIndex(index);
      if (!recorded.ok) {
        console.log(`Could not safely test remaining branch answer "${optionTexts[index]}". Skipping only this answer and continuing with the collected outcomes.`);
        continue;
      }
      alreadyTested.add(index);
    }

    const uniqueOutcomes = uniqueBranchOutcomeGroups(outcomes);

    if (uniqueOutcomes.length <= 1) {
      console.log('After full comparison, all answers collapsed to one unique next page. No conditional screenshots will be created.');
      const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
      if (!restored) {
        console.log('Branch source could not be restored. Preserving the current landing page for the next numbered screenshot.');
        return outcomes.length > 0;
      }
      const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
      return finalResult.advanced;
    }

    // Distinguish a true transition page from a conditional NEXT QUESTION.
    // A landing page that already contains another answer group is not a passive
    // transition. Previously we saved those as source-page letters (07a, 07b...)
    // and then tried to auto-advance them as if they were transitions, which can
    // juxtapose two consecutive question steps and stop the crawl.
    const conditionalQuestionOutcomes = uniqueOutcomes.filter(item => (item.landingState?.group?.length || 0) >= 2);
    const conditionalTransitionOutcomes = uniqueOutcomes.filter(item => (item.landingState?.group?.length || 0) < 2);

    if (conditionalTransitionOutcomes.length > 0) {
      console.log(`Saving ${conditionalTransitionOutcomes.length} genuine conditional transition page(s) as source-page lettered screenshots.`);
      for (let i = 0; i < conditionalTransitionOutcomes.length; i++) {
        const filename = nextFreeLetteredFilename(screenNumber);
        if (!filename) continue;
        fs.writeFileSync(filename, conditionalTransitionOutcomes[i].screenshotBuffer);
        console.log(`Captured ${path.basename(filename)} transition for answer(s): ${conditionalTransitionOutcomes[i].answers.join(' | ')}`);
      }
    }

    if (conditionalQuestionOutcomes.length > 1) {
      // The first normal path will become the next numbered screenshot (for example
      // 08.png). Save only the ALTERNATE next-question variants as 08a, 08b, ...
      // rather than incorrectly attaching them to the source question as 07a, 07b.
      const canonicalQuestionOutcome = conditionalQuestionOutcomes.find(item => item.answers.includes(optionTexts[0])) || conditionalQuestionOutcomes[0];
      const alternateQuestionOutcomes = conditionalQuestionOutcomes.filter(item => item !== canonicalQuestionOutcome);
      console.log(`Conditional next-question variants detected: ${conditionalQuestionOutcomes.length}. The main path will be ${String(screenNumber + 1).padStart(2, '0')}.png; saving ${alternateQuestionOutcomes.length} alternate variant(s) beside it.`);
      for (const outcome of alternateQuestionOutcomes) {
        const filename = nextFreeLetteredFilename(screenNumber + 1);
        if (!filename) continue;
        fs.writeFileSync(filename, outcome.screenshotBuffer);
        console.log(`Captured ${path.basename(filename)} conditional next-question variant for answer(s): ${outcome.answers.join(' | ')}`);
      }
    }

    const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
    if (!restored) {
      console.log('Conditional pages were captured, but the main question could not be restored safely. Preserving the current landing page for the next numbered screenshot.');
      return true;
    }

    const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
    if (!finalResult.advanced || !finalResult.landingState) return false;
    const mainFingerprint = normalizeContextText(finalResult.landingState.pageText);
    // Skip the next numbered page ONLY when it is a genuine transition that was
    // already saved under the source screen. Never skip a conditional question:
    // it must become the next numbered screenshot and remain actionable.
    if (conditionalTransitionOutcomes.some(item => item.fingerprint === mainFingerprint)) {
      skipNextNumberedFingerprint = mainFingerprint;
      console.log('Main path is currently on a genuine transition already captured as a source-page lettered screenshot; the duplicate numbered transition will be skipped.');
    } else if ((finalResult.landingState?.group?.length || 0) >= 2) {
      console.log('Main path landed on another question, not a transition. It will be captured normally as the next numbered screen.');
    }
    return true;
  }

  async function handleExplicitAgeSelection(state) {
    const targetAge = 25;

    const stateStillLooksLikeAgeStep = candidateState => {
      if (!candidateState) return false;
      const evidence = getAgeQuestionEvidence(candidateState);
      return evidence.explicitAgeIntent || evidence.hasAgeLabeledChoices;
    };

    const waitForLeavingAgeStep = async (beforeUrl, beforePrompt, timeoutMs = 12000) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        await page.waitForTimeout(400);
        await silenceMedia();
        const current = await inspectPageNavigationSafe('age-step advancement check').catch(() => null);
        if (!current) continue;

        const currentUrl = sanitizeUrl(page.url());
        if (currentUrl !== beforeUrl) return true;

        const currentPrompt = questionPromptFingerprint(current);
        if (beforePrompt && currentPrompt && contextSimilarity(beforePrompt, currentPrompt) < 0.72) {
          return true;
        }

        if (!stateStillLooksLikeAgeStep(current)) return true;
      }
      return false;
    };

    const { explicitAgeIntent, hasAgeLabeledChoices } = getAgeQuestionEvidence(state);

    // A manual age form may have no answer cards at all. Give its editable
    // control to the numeric profile handler before treating a CTA as proof
    // that an age choice has already been made.
    if (shouldDeferAgeSelectionToForm(state) && await hasVisibleEditableInput()) {
      console.log('Age entry field detected; using the numeric age input handler.');
      return { handled: false, advanced: false };
    }

    // If this exact age step has already had a choice selected, many funnels keep
    // the same URL/title and only enable a bottom Next button. Do NOT click the age
    // option again: on radio-like implementations that can toggle the selection off
    // and send the crawler back to the previously captured unselected state.
    if (explicitAgeIntent && state?.cta && isStrongNavigationText(state.cta.text || '')) {
      console.log('Age choice is already selected and navigation is available. Using:', state.cta.text || 'Next');
      const beforeUrl = sanitizeUrl(page.url());
      const beforePrompt = questionPromptFingerprint(state);
      const clicked = await safeCrawlerClick(
        page.locator(`[data-auto-id="${state.cta.id}"]`),
        state.cta.text || 'age selection navigation CTA'
      );
      if (!clicked) return { handled: true, advanced: false };
      const advanced = await waitForLeavingAgeStep(beforeUrl, beforePrompt, 12000);
      if (!advanced) console.log('Age navigation CTA was clicked, but the crawler remained on the age step.');
      return { handled: true, advanced };
    }

    // Age can be a card/choice task, not only a writable numeric input.
    // If most answer choices are age ranges, choose the range containing age 25
    // before speech detection, branch probing, or numeric-input handling.
    const ageRangeOptions = (state?.group || []).map(option => {
      const raw = (option.text || '').trim();
      const normalized = raw.replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();

      // Bare numeric ranges also describe repetitions, time, or other quantities.
      // When the question does not ask about age, require age-specific wording on
      // most answer labels before choosing a bucket for the age-25 profile.
      if (!explicitAgeIntent && (!hasAgeLabeledChoices || !hasAgeLabel(normalized))) return null;

      const range = normalized.match(/^(?:age\s*:?\s*)?(\d{1,3})\s*-\s*(\d{1,3})(?:\s*(?:years?|yrs?)(?:\s*old)?)?$/i);
      const plus = normalized.match(/^(?:age\s*:?\s*)?(\d{1,3})\s*\+(?:\s*(?:years?|yrs?)(?:\s*old)?)?$/i);
      const decade = normalized.match(/^(?:age\s*:?\s*)?(\d{2})\s*'?s(?:\s*(?:years?|yrs?)(?:\s*old)?)?$/i);
      const symbolicUnder = normalized.match(/^(?:age\s*:?\s*)?<\s*(\d{1,3})(?:\s*(?:years?|yrs?)(?:\s*old)?)?$/i);
      const symbolicOver = normalized.match(/^(?:age\s*:?\s*)?>\s*(\d{1,3})(?:\s*(?:years?|yrs?)(?:\s*old)?)?$/i);
      const wordUnder = normalized.match(/^(?:age\s*:?\s*)?(?:under|below|less than)\s*(\d{1,3})(?:\s*(?:years?|yrs?)(?:\s*old)?)?$/i);
      const wordOver = normalized.match(/^(?:age\s*:?\s*)?(?:over|above|older than)\s*(\d{1,3})(?:\s*(?:years?|yrs?)(?:\s*old)?)?$/i);
      if (range) return { option, min: Number(range[1]), max: Number(range[2]), raw };
      if (plus) return { option, min: Number(plus[1]), max: Infinity, raw };
      if (decade) {
        const start = Number(decade[1]);
        return { option, min: start, max: start + 9, raw };
      }
      if (symbolicUnder || wordUnder) {
        const limit = Number((symbolicUnder || wordUnder)[1]);
        return { option, min: -Infinity, max: limit - 1, raw };
      }
      if (symbolicOver || wordOver) {
        const limit = Number((symbolicOver || wordOver)[1]);
        return { option, min: limit + 1, max: Infinity, raw };
      }
      return null;
    }).filter(Boolean);

    if (ageRangeOptions.length >= 2 && ageRangeOptions.length >= Math.ceil((state?.group?.length || 0) * 0.6)) {
      const ageDistance = item => {
        if (targetAge >= item.min && targetAge <= item.max) return 0;
        if (targetAge < item.min) return item.min - targetAge;
        return targetAge - item.max;
      };
      const chosen = ageRangeOptions
        .slice()
        .sort((a, b) => ageDistance(a) - ageDistance(b))[0];
      const exactBucket = ageDistance(chosen) === 0;
      console.log(
        exactBucket
          ? `Age-range choice page detected from answer options. Choosing the bucket containing age ${targetAge}:`
          : `Age-range choice page detected from answer options. No bucket contains age ${targetAge}; choosing the nearest bucket instead:`,
        chosen.raw
      );

      const beforeUrl = sanitizeUrl(page.url());
      const beforePrompt = questionPromptFingerprint(state);
      const clicked = await safeCrawlerClick(
        page.locator(`[data-auto-id="${chosen.option.id}"]`),
        chosen.raw || 'age-range option'
      );
      if (!clicked) return { handled: true, advanced: false };

      await page.waitForTimeout(500);
      let afterSelection = await inspectPageNavigationSafe('age-range choice post-click');

      // A changed text signature is NOT enough here: enabling "Next" changes body
      // text while still remaining on the exact same age step.
      const afterUrl = sanitizeUrl(page.url());
      const afterPrompt = questionPromptFingerprint(afterSelection);
      const actuallyLeftAgeStep =
        afterUrl !== beforeUrl ||
        (beforePrompt && afterPrompt && contextSimilarity(beforePrompt, afterPrompt) < 0.72) ||
        !stateStillLooksLikeAgeStep(afterSelection);

      if (actuallyLeftAgeStep) return { handled: true, advanced: true };

      const nav = await clickStrongNavigation(afterSelection, 'age-range selection navigation CTA');
      if (nav.handled) {
        if (!nav.advanced) return { handled: true, advanced: false };
        const leftAgeStep = await waitForLeavingAgeStep(beforeUrl, beforePrompt, 12000);
        return { handled: true, advanced: leftAgeStep };
      }

      console.log('Age option did not advance from its nested control and no Next/Continue CTA appeared. Retrying the containing age card once.');
      const cardAdvanced = await clickAnswerCardFallback(chosen.raw || '', pageSignature(state));
      if (cardAdvanced) {
        const leftAgeStep = await waitForLeavingAgeStep(beforeUrl, beforePrompt, 8000);
        return { handled: true, advanced: leftAgeStep };
      }

      return { handled: true, advanced: false };
    }

    if (!explicitAgeIntent) return { handled: false, advanced: false };

    const candidate = await page.evaluate(({ targetAge }) => {
      const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
      const visible = el => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
          r.top < window.innerHeight && r.left < window.innerWidth &&
          style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      };
      const reachable = el => {
        if (!visible(el)) return false;
        const r = el.getBoundingClientRect();
        const x = Math.max(0, Math.min(window.innerWidth - 1, r.left + r.width / 2));
        const y = Math.max(0, Math.min(window.innerHeight - 1, r.top + r.height / 2));
        const top = document.elementFromPoint(x, y);
        return !!top && (top === el || el.contains(top) || top.contains(el));
      };
      const containsTargetAge = text => {
        const t = normalize(text).toLowerCase();
        if (!t) return false;
        const range = t.match(/(?:age\s*[:\-]?\s*)?(\d{1,3})\s*[-–—]\s*(\d{1,3})/i);
        if (range) {
          const low = Number(range[1]);
          const high = Number(range[2]);
          return targetAge >= Math.min(low, high) && targetAge <= Math.max(low, high);
        }
        const plus = t.match(/(?:age\s*[:\-]?\s*)?(\d{1,3})\s*\+/i);
        if (plus) return targetAge >= Number(plus[1]);
        const decade = t.match(/(?:age\s*[:\-]?\s*)?(\d{2})\s*'?s\b/i);
        if (decade) {
          const start = Number(decade[1]);
          return targetAge >= start && targetAge <= start + 9;
        }
        const symbolicUnder = t.match(/^\s*<\s*(\d{1,3})\s*$/i);
        if (symbolicUnder) return targetAge < Number(symbolicUnder[1]);
        const symbolicOver = t.match(/^\s*>\s*(\d{1,3})\s*$/i);
        if (symbolicOver) return targetAge > Number(symbolicOver[1]);
        const under = t.match(/(?:under|below|less than)\s*(\d{1,3})/i);
        if (under) return targetAge < Number(under[1]);
        const over = t.match(/(?:over|above|older than)\s*(\d{1,3})/i);
        if (over) return targetAge > Number(over[1]);
        const exact = t.match(/(?:age\s*[:\-]?\s*)?(\d{1,3})\b/i);
        return !!exact && Number(exact[1]) === targetAge;
      };
      const looksLikeAgeChoice = text => /(?:age\s*[:\-]?\s*)?\d{1,3}\s*(?:[-–—]\s*\d{1,3}|\+|'?s\b)?|^[<>]\s*\d{1,3}$|(?:under|below|over|above|older than|less than)\s*\d{1,3}/i.test(normalize(text));

      const selectors = 'button, a, label, [role="button"], [role="radio"], [role="option"], [onclick], [tabindex]';
      const elements = Array.from(document.querySelectorAll(selectors)).filter(visible);
      const candidates = [];
      for (const el of elements) {
        const text = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
        if (!looksLikeAgeChoice(text) || !reachable(el)) continue;
        const r = el.getBoundingClientRect();
        let score = 0;
        if (containsTargetAge(text)) score += 1000;
        if (/\bage\b/i.test(text)) score += 80;
        if (r.width >= 100 && r.height >= 45) score += 30;
        score -= Math.min((r.width * r.height) / 10000, 40);
        candidates.push({ el, text, score, top: r.top });
      }

      if (!candidates.length) return null;
      candidates.sort((a, b) => b.score - a.score || a.top - b.top);
      const best = candidates[0];
      if (!containsTargetAge(best.text)) return null;
      const id = `crawler-age-choice-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
      best.el.setAttribute('data-crawler-age-choice-id', id);
      return { id, text: best.text };
    }, { targetAge });

    if (!candidate) {
      if (shouldDeferAgeSelectionToForm(state)) {
        console.log('No age choice cards found; checking for a manual age input.');
        return { handled: false, advanced: false };
      }
      console.log('Age-selection intent detected, but no reachable option containing age 25 was found.');
      return { handled: true, advanced: false };
    }

    console.log(`Age-selection page detected from title/subtitle. Choosing the option that contains age ${targetAge}:`, candidate.text);
    const beforeState = await inspectPageNavigationSafe('age choice pre-click');
    const beforeUrl = sanitizeUrl(page.url());
    const beforePrompt = questionPromptFingerprint(beforeState);
    const clicked = await safeCrawlerClick(
      page.locator(`[data-crawler-age-choice-id="${candidate.id}"]`),
      `age option ${candidate.text}`
    );
    if (!clicked) return { handled: true, advanced: false };

    await page.waitForTimeout(500);
    const afterSelection = await inspectPageNavigationSafe('age choice post-click');
    const afterUrl = sanitizeUrl(page.url());
    const afterPrompt = questionPromptFingerprint(afterSelection);
    const actuallyLeftAgeStep =
      afterUrl !== beforeUrl ||
      (beforePrompt && afterPrompt && contextSimilarity(beforePrompt, afterPrompt) < 0.72) ||
      !stateStillLooksLikeAgeStep(afterSelection);

    if (actuallyLeftAgeStep) return { handled: true, advanced: true };

    const nav = await clickStrongNavigation(afterSelection, 'age selection navigation CTA');
    if (nav.handled) {
      if (!nav.advanced) return { handled: true, advanced: false };
      const leftAgeStep = await waitForLeavingAgeStep(beforeUrl, beforePrompt, 12000);
      return { handled: true, advanced: leftAgeStep };
    }

    return { handled: true, advanced: false };
  }

  async function handlePassiveEvaluationGate(state) {
    // Evaluation can pause for answer cards OR a dropdown. A select is not
    // an answer group, so inspect it before requiring two card options.
    if (!state) return { handled: false, advanced: false };
    const normalizedPageText = (state.pageText || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const hasProgressPercent = /(?:^|\s)(?:[1-9]?\d|100)%(?:\s|$)/.test(normalizedPageText);
    const evaluationLanguage = /\b(matching|analyzing|analysing|processing|loading|calculating|assessing|evaluating|scoring|preparing|building|creating|generating|personalizing|personalising|tailoring|compiling)\b/.test(normalizedPageText);
    const evaluationGateContext = isPassiveTransitionScreen(state.pageText) || (hasProgressPercent && evaluationLanguage);
    if (!evaluationGateContext) return { handled: false, advanced: false };

    const dropdown = await findEvaluationDropdown(page);
    const beforeSignature = pageSignature(state);
    const beforeUrl = sanitizeUrl(page.url());
    if (dropdown) {
      const result = await chooseEvaluationDropdown(page, dropdown, safeCrawlerClick);
      if (!result.selected) return { handled: result.handled, advanced: false };
    } else {
      if ((state.group || []).length < 2) return { handled: false, advanced: false };
      const instruction = getSelectionInstruction(state.pageText);
      if ((instruction.minSelections || 1) !== 1 || (instruction.maxSelections !== null && instruction.maxSelections !== 1)) {
        return { handled: false, advanced: false };
      }
      const optionTexts = state.group.map(item => (item.text || '').trim()).filter(Boolean);
      const shortChoiceGate = optionTexts.length <= 4 && optionTexts.every(text => text.length <= 80);
      if (!shortChoiceGate) return { handled: false, advanced: false };
      console.log('Passive evaluation gate detected. Selecting one answer to resume the evaluation; branch exploration is intentionally skipped.');
      const option = state.group[0];
      const clicked = await safeCrawlerClick(
        page.locator(`[data-auto-id="${option.id}"]`),
        option.text || 'passive evaluation answer'
      );
      if (!clicked) return { handled: true, advanced: false };
    }

    // The answer may only remove the question while the progress animation keeps
    // running. Wait for the evaluation itself to finish instead of treating each
    // percentage/progress update as a new numbered page.
    const startedAt = Date.now();
    const timeoutMs = 60000;
    let sawMeaningfulChange = false;
    while (Date.now() - startedAt < timeoutMs) {
      await page.waitForTimeout(500);
      await silenceMedia();
      const current = await inspectPageNavigationSafe('passive evaluation gate');
      const currentSignature = pageSignature(current);
      const urlChanged = sanitizeUrl(page.url()) !== beforeUrl;
      if (currentSignature !== beforeSignature) sawMeaningfulChange = true;

      if (urlChanged || !isPassiveTransitionScreen(current.pageText)) {
        console.log('Passive evaluation resumed and completed. Continuing to the resulting page.');
        return { handled: true, advanced: true };
      }

      // Another gate can pause the same evaluation. Capture it on the next
      // iteration instead of waiting 60 seconds for progress it is blocking.
      const nextDropdown = await findEvaluationDropdown(page);
      const nextChoices = (current.group || []).map(item => item.text).join('\n');
      const previousChoices = (state.group || []).map(item => item.text).join('\n');
      if ((nextDropdown && nextDropdown.id !== dropdown?.id) ||
          ((current.group || []).length >= 2 && nextChoices !== previousChoices)) {
        console.log('Evaluation reached another answer gate. Continuing so it can be captured and answered.');
        return { handled: true, advanced: true };
      }

      // If the evaluation exposes a real navigation CTA after processing, use it.
      if (current.cta && isStrongNavigationText(current.cta.text || '')) {
        const navBefore = pageSignature(current);
        const navClicked = await safeCrawlerClick(
          page.locator(`[data-auto-id="${current.cta.id}"]`),
          current.cta.text || 'post-evaluation CTA'
        );
        if (navClicked && await waitForAdvancement(navBefore, 12000)) {
          return { handled: true, advanced: true };
        }
      }
    }

    if (sawMeaningfulChange) {
      console.log('Passive evaluation changed after the answer but did not fully finish within 60s; continuing from the latest state.');
      return { handled: true, advanced: true };
    }
    console.log('Passive evaluation answer was selected, but the evaluation did not resume within 60s.');
    return { handled: true, advanced: false };
  }

  async function handleMatchingPairs(state) {
    if (!/\b(match(?:ing)? pairs?|tap the matching pairs|pair the words)\b/i.test(state.pageText || '')) {
      return { handled: false, advanced: false };
    }
    const beforeSignature = pageSignature(state);
    // Locate exact equal-text pairs in separate columns. Match by DOM identity,
    // not text alone: the same word must be clicked twice, once in each column.
    const pairs = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], [data-auto-id]'));
      const visible = el => {
        const r=el.getBoundingClientRect(),cs=getComputedStyle(el);
        return r.width > 40 && r.height > 25 && r.top >= 0 && r.bottom < innerHeight &&
          cs.display !== 'none' && cs.visibility !== 'hidden' && cs.pointerEvents !== 'none';
      };
      const tiles=nodes.filter(visible).map(el=>({
        el, text:(el.innerText || el.textContent || '').replace(/\s+/g,' ').trim().toLowerCase(),
        x:el.getBoundingClientRect().left+el.getBoundingClientRect().width/2,
        y:el.getBoundingClientRect().top
      })).filter(x=>x.text && x.text.length<=35 && !/^(check|continue|next|back|skip)$/.test(x.text));
      const groups=new Map();
      for(const tile of tiles) {
        if(!groups.has(tile.text)) groups.set(tile.text,[]);
        groups.get(tile.text).push(tile);
      }
      const matches=[];
      for(const [word,options] of groups) {
        if(options.length!==2) continue;
        const [left,right]=options.sort((a,b)=>a.x-b.x);
        if(right.x-left.x<65) continue;
        matches.push({word,left,right,top:Math.min(left.y,right.y)});
      }
      if(matches.length<2) return [];
      matches.sort((a,b)=>a.top-b.top);
      return matches.map((pair,i)=>{
        const l='crawler-pair-left-'+i,r='crawler-pair-right-'+i;
        pair.left.el.setAttribute('data-crawler-pair-id',l);
        pair.right.el.setAttribute('data-crawler-pair-id',r);
        return {word:pair.word,left:l,right:r};
      });
    }).catch(()=>[]);
    if (!pairs.length) return { handled: false, advanced: false };
    console.log('Matching-pairs interaction detected:', pairs.map(x=>x.word).join(', '));
    for(const pair of pairs) {
      for(const id of [pair.left,pair.right]) {
        const tile=page.locator('[data-crawler-pair-id="'+id+'"]');
        if(!await tile.isVisible().catch(()=>false)) break;
        if(!await tile.isEnabled().catch(()=>false)) break;
        if(!await safeCrawlerClick(tile,'matching tile '+pair.word)) return {handled:true,advanced:false};
        await page.waitForTimeout(220);
      }
      await page.waitForTimeout(350);
      const current=await inspectPageNavigationSafe('matched-pair progress');
      if(sanitizeUrl(page.url())!==sanitizeUrl(state.url || page.url()) ||
         (questionPromptFingerprint(current) && questionPromptFingerprint(state) &&
          contextSimilarity(questionPromptFingerprint(current),questionPromptFingerprint(state))<0.75)) {
        return {handled:true,advanced:true};
      }
    }
    const check=page.getByRole('button',{name:/^(check|continue|next|done|submit)$/i}).first();
    if(await check.count() && await check.isVisible().catch(()=>false) && await check.isEnabled().catch(()=>false)) {
      console.log('Matching-pairs CTA unlocked. Submitting.');
      const clicked=await safeCrawlerClick(check,'matching-pairs submit');
      if(clicked && await waitForAdvancement(beforeSignature,12000)) return {handled:true,advanced:true};
    }
    console.log('Matching-pairs handler finished without confirmed navigation.');
    return {handled:true,advanced:false};
  }

  // Dedicated legal acceptance buttons supplement the checkbox handlers. Generic
  // Continue/answer buttons remain with the normal funnel navigation logic.
  async function handleLegalAcceptanceButton(state) {
    const target = await page.evaluate(() => {
      const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
      const legal = /\b(?:terms(?:\s+of\s+(?:use|service))?|conditions|privacy\s+policy|user\s+agreement)\b/i;
      const acceptance = /^(?:(?:i\s+)?(?:agree|accept)(?:\s+(?:to\s+)?(?:the\s+)?(?:terms(?:\s+of\s+(?:use|service))?|conditions|privacy\s+policy)(?:\s+(?:and|&)\s+(?:terms|conditions|privacy\s+policy))?)?(?:\s+(?:and|&)\s+(?:continue|proceed))?|accept\s+and\s+continue)[.!]?$/i;
      const excluded = /\b(?:cookies?|marketing|newsletter|promotions?|subscribe|subscription|purchase|buy|pay|checkout|trial|billing|charge|order)\b|[$€£¥]/i;
      const candidates = [];
      for (const el of document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')) {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (el.disabled || el.getAttribute('aria-disabled') === 'true' ||
            rect.width <= 0 || rect.height <= 0 || style.display === 'none' ||
            style.visibility === 'hidden' || Number(style.opacity) === 0 || style.pointerEvents === 'none') continue;
        const text = normalize(el.innerText || el.value || el.getAttribute('aria-label'));
        if (!acceptance.test(text) || excluded.test(text)) continue;
        // Use the closest meaningful container, so a footer Terms link cannot
        // turn an unrelated Accept button elsewhere on the page into consent.
        let context = el.parentElement;
        while (context && context !== document.body && normalize(context.innerText).length < 25) context = context.parentElement;
        const contextText = normalize(context?.innerText);
        if (!legal.test(contextText) || excluded.test(contextText)) continue;
        candidates.push({ el, text });
      }
      // Ambiguous controls are left for normal dispatch/recovery rather than
      // choosing a potentially unrelated action by document order.
      if (candidates.length !== 1) return null;
      const { el, text } = candidates[0];
      const id = `legal-acceptance-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
      el.setAttribute('data-crawler-legal-acceptance-id', id);
      return { id, text };
    });
    if (!target) return { handled: false, advanced: false };
    const consent = await handleRequiredPageConsentCheckboxes();
    if (consent.found && !consent.active) return { handled: true, advanced: false };
    const before = pageSignature(state);
    console.log('Automatically accepting funnel Terms/Privacy:', target.text);
    const clicked = await safeCrawlerClick(page.locator(`[data-crawler-legal-acceptance-id="${target.id}"]`), target.text);
    if (!clicked) return { handled: true, advanced: false };
    return { handled: true, advanced: await waitForAdvancement(before, 12000) };
  }

  async function advanceOneScreen(state, screenNumber = null) {
    const legalAcceptance = await handleLegalAcceptanceButton(state);
    if (legalAcceptance.handled) return legalAcceptance.advanced;
    const handledEnglishLanguageChoice = await handleEnglishLanguageChoice();
    if (handledEnglishLanguageChoice) return true;
    if (isNativeLanguageQuestion(state.pageText)) {
      const handledCustomLanguage = await handleCustomNativeLanguage(state);
      if (handledCustomLanguage) return true;
    }
    const skippedOptionalInput = await handleSkippableInputRequirement(state);
    if (skippedOptionalInput) return true;

    const pairsResult = await handleMatchingPairs(state);
    if (pairsResult.handled) return pairsResult.advanced;

    const scratchResult = await handleScratchReveal(screenNumber, state);
    if (scratchResult.handled) return scratchResult.advanced;

    // Explicit title/subtitle intent outranks generic answer-card logic. For age
    // selection pages, choose the range containing age 25 instead of branch-probing.
    const ageChoiceResult = await handleExplicitAgeSelection(state);
    if (ageChoiceResult.handled) return ageChoiceResult.advanced;

    // Semantic profile-number forms (height/weight/goal weight/age) need
    // deterministic values and, for weight screens, controlled response captures.
    const profileNumericResult = await handleProfileNumericInput(state, screenNumber);
    if (profileNumericResult.recognized) return profileNumericResult.advanced;

    // Foreground forms must outrank navigation controls that may still exist
    // behind an overlay (for example, an email gate covering a prior Continue button).
    const formResult = await handleGenericFormInput(state);
    if (formResult.recognized) return formResult.advanced;

    const navigationResult = await clickStrongNavigation(state);
    if (navigationResult.handled) return navigationResult.advanced;

    state = await inspectPage();
    if (state.group.length > 0) return await handleAnswerGroup(state, screenNumber);
    if (state.cta) {
      console.log('Primary CTA detected:', state.cta.text || '(no text)');
      const beforeSignature = pageSignature(state);
      const clicked = await safeCrawlerClick(page.locator(`[data-auto-id="${state.cta.id}"]`), state.cta.text || 'primary CTA');
      if (!clicked) return false;
      return await waitForAdvancement(beforeSignature, 12000);
    }

    const fallbackNavigationResult = await clickStrongNavigation(await inspectPage());
    if (fallbackNavigationResult.handled) return fallbackNavigationResult.advanced;

    const delayedResult = await waitForActionableState();
    if (!delayedResult) return false;
    if (delayedResult.changed) return true;
    return await advanceOneScreen(delayedResult.state, screenNumber);
  }

  async function dismissPaywallObscuringPopup(maxAttempts = 4) {
    // Paywalls sometimes show a temporary upsell/discount modal over the actual
    // pricing page. We only dismiss overlays that expose an explicit negative or
    // close action; we never click the positive offer CTA (Claim discount, Buy,
    // Continue, etc.). This keeps the underlying paywall readable without
    // accidentally purchasing/selecting an offer.
    const findDismissTarget = async () => {
      return await page.evaluate(() => {
        const overlaySelector = [
          'dialog',
          '[role="dialog"]',
          '[aria-modal="true"]',
          '[class*="modal" i]',
          '[class*="popup" i]',
          '[class*="overlay" i]',
          '[class*="sheet" i]',
          '[class*="drawer" i]'
        ].join(', ');
        const clickableSelector = 'button, a, [role="button"], [onclick], [tabindex]';
        const negativePattern = /^(?:close|dismiss|no thanks|no, thanks|not now|maybe later|skip|decline|continue without(?: this)?|i don['’]?t want it|i do not want it|i don['’]?t want this|no,? i don['’]?t want it)$/i;
        const closeLabelPattern = /\b(close|dismiss)\b/i;

        const visible = el => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
            r.top < window.innerHeight && r.left < window.innerWidth &&
            st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0 &&
            st.pointerEvents !== 'none';
        };
        const reachable = el => {
          if (!visible(el)) return false;
          const r = el.getBoundingClientRect();
          const x = Math.max(0, Math.min(window.innerWidth - 1, r.left + r.width / 2));
          const y = Math.max(0, Math.min(window.innerHeight - 1, r.top + r.height / 2));
          const top = document.elementFromPoint(x, y);
          return !!top && (top === el || el.contains(top) || top.contains(el));
        };

        const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
        const overlays = Array.from(document.querySelectorAll(overlaySelector))
          .filter(visible)
          .map(el => {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            const areaRatio = (r.width * r.height) / viewportArea;
            const z = Number.parseInt(st.zIndex || '0', 10) || 0;
            const modalSemantic = el.matches('dialog, [role="dialog"], [aria-modal="true"]');
            const fixedLike = st.position === 'fixed' || st.position === 'sticky';
            return { el, r, areaRatio, z, modalSemantic, fixedLike };
          })
          // Exclude tiny badges/tooltips and ordinary inline cards. A real blocking
          // promo is normally modal-semantic or fixed/sticky and covers a meaningful
          // part of the viewport.
          .filter(item => item.areaRatio >= 0.12 && (item.modalSemantic || item.fixedLike || item.z > 10))
          .sort((a, b) => b.z - a.z || b.areaRatio - a.areaRatio);

        for (const overlay of overlays) {
          const controls = Array.from(overlay.el.querySelectorAll(clickableSelector))
            .filter(el => visible(el) && reachable(el));
          const scored = [];

          for (const control of controls) {
            const r = control.getBoundingClientRect();
            const text = (control.innerText || control.textContent || '').replace(/\s+/g, ' ').trim();
            const aria = (control.getAttribute('aria-label') || '').trim();
            const title = (control.getAttribute('title') || '').trim();
            const combinedLabel = `${aria} ${title}`.trim();
            let score = 0;
            let reason = '';

            if (negativePattern.test(text)) {
              score = 100;
              reason = `negative action: ${text}`;
            } else if (closeLabelPattern.test(combinedLabel)) {
              score = 95;
              reason = `close control: ${combinedLabel}`;
            } else {
              // Icon-only X/close buttons commonly live in the top-right of the
              // modal. Only accept a small control near that corner so we do not
              // mistake a large offer CTA for a dismiss action.
              const nearTopRight = r.top <= overlay.r.top + Math.max(90, overlay.r.height * 0.20) &&
                r.right >= overlay.r.right - Math.max(90, overlay.r.width * 0.22);
              const small = r.width <= 72 && r.height <= 72;
              const iconOnly = !text && !!control.querySelector('svg, img, [class*="icon" i]');
              if (nearTopRight && small && iconOnly) {
                score = 80;
                reason = 'top-right icon close control';
              }
            }

            if (!score) continue;
            const id = `crawler-paywall-dismiss-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
            control.setAttribute('data-crawler-paywall-dismiss-id', id);
            scored.push({ id, score, reason });
          }

          scored.sort((a, b) => b.score - a.score);
          if (scored.length) return { ...scored[0], overlayFound: true };
        }

        return { overlayFound: overlays.length > 0, id: null, score: 0, reason: '' };
      }).catch(() => ({ overlayFound: false, id: null, score: 0, reason: '' }));
    };

    let dismissedAny = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const target = await findDismissTarget();
      if (!target?.overlayFound) break;

      if (!target.id) {
        // Some dialogs only support Escape. Try it once, then re-check whether the
        // blocking overlay actually disappeared. If it did not, leave the UI alone
        // rather than clicking arbitrary paywall controls.
        const beforeCount = await page.locator('dialog:visible, [role="dialog"]:visible, [aria-modal="true"]:visible, [class*="modal" i]:visible, [class*="popup" i]:visible, [class*="overlay" i]:visible, [class*="sheet" i]:visible, [class*="drawer" i]:visible').count().catch(() => 0);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(600);
        const afterCount = await page.locator('dialog:visible, [role="dialog"]:visible, [aria-modal="true"]:visible, [class*="modal" i]:visible, [class*="popup" i]:visible, [class*="overlay" i]:visible, [class*="sheet" i]:visible, [class*="drawer" i]:visible').count().catch(() => beforeCount);
        if (afterCount < beforeCount) {
          console.log('Dismissed paywall-obscuring popup with Escape.');
          dismissedAny = true;
          continue;
        }
        console.log('Paywall overlay detected, but no safe dismiss/decline control was found. Leaving it untouched.');
        break;
      }

      console.log(`Paywall-obscuring popup detected. Dismissing via ${target.reason || 'safe close control'}.`);
      const clicked = await safeCrawlerClick(
        page.locator(`[data-crawler-paywall-dismiss-id="${target.id}"]`),
        target.reason || 'paywall popup dismiss control'
      );
      if (!clicked) break;
      dismissedAny = true;
      await page.waitForTimeout(700);
      await silenceMedia();
    }

    return dismissedAny;
  }

  async function measurePaywallCaptureGeometry() {
    return await page.evaluate(() => {
      const viewportWidth = Math.max(1, window.innerWidth || 390);
      const viewportHeight = Math.max(1, window.innerHeight || 844);
      const rootHeight = Math.max(
        viewportHeight,
        document.documentElement?.scrollHeight || 0,
        document.body?.scrollHeight || 0
      );

      let best = null;
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (rect.width < viewportWidth * 0.62 || rect.height < viewportHeight * 0.28) continue;
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
        if (el.scrollHeight <= el.clientHeight + 80) continue;
        const overflowY = style.overflowY;
        const explicitlyScrollable = /auto|scroll|overlay/i.test(overflowY);
        const fillsViewport = rect.height >= viewportHeight * 0.65;
        if (!explicitlyScrollable && !fillsViewport) continue;

        const score = el.scrollHeight * Math.min(1, rect.width / viewportWidth);
        if (!best || score > best.score) best = { el, score, rect };
      }

      if (best) {
        const marker = `crawler-paywall-scroll-root-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
        best.el.setAttribute('data-crawler-paywall-scroll-root', marker);
        return {
          viewportWidth,
          viewportHeight,
          rootHeight,
          internalScrollHeight: best.el.scrollHeight,
          internalClientHeight: best.el.clientHeight,
          internalTop: Math.max(0, best.rect.top),
          marker,
          captureHeight: Math.min(12000, Math.max(rootHeight, best.el.scrollHeight + Math.max(0, best.rect.top) + 24))
        };
      }

      return {
        viewportWidth,
        viewportHeight,
        rootHeight,
        internalScrollHeight: 0,
        internalClientHeight: 0,
        internalTop: 0,
        marker: '',
        captureHeight: Math.min(12000, rootHeight)
      };
    });
  }

  async function primePaywallLazyContent(geometry) {
    if (!geometry?.marker || !geometry.internalScrollHeight) return;
    const step = Math.max(350, Math.floor((geometry.internalClientHeight || geometry.viewportHeight || 844) * 0.72));
    for (let y = 0; y < geometry.internalScrollHeight; y += step) {
      await page.evaluate(({ marker, y }) => {
        const el = document.querySelector(`[data-crawler-paywall-scroll-root="${CSS.escape(marker)}"]`);
        if (el) el.scrollTop = y;
      }, { marker: geometry.marker, y }).catch(() => {});
      await page.waitForTimeout(140);
    }
    await page.evaluate((marker) => {
      const el = document.querySelector(`[data-crawler-paywall-scroll-root="${CSS.escape(marker)}"]`);
      if (el) el.scrollTop = 0;
    }, geometry.marker).catch(() => {});
    await page.waitForTimeout(350);
  }

  async function unclipPaywallScrollContainer(geometry) {
    if (!geometry?.marker) return;
    await page.evaluate((marker) => {
      const el = document.querySelector(`[data-crawler-paywall-scroll-root="${CSS.escape(marker)}"]`);
      if (!el) return;

      const contentHeight = Math.max(el.scrollHeight, el.clientHeight);
      el.style.setProperty('height', `${contentHeight}px`, 'important');
      el.style.setProperty('max-height', 'none', 'important');
      el.style.setProperty('overflow-y', 'visible', 'important');
      el.style.setProperty('overflow', 'visible', 'important');

      let parent = el.parentElement;
      let hops = 0;
      while (parent && parent !== document.body && hops < 6) {
        const style = getComputedStyle(parent);
        const rect = parent.getBoundingClientRect();
        const clipsVertically = /hidden|clip|auto|scroll|overlay/i.test(style.overflowY || style.overflow || '');
        const heightBound = rect.height > 0 && rect.height < contentHeight - 40;
        if (clipsVertically || heightBound) {
          parent.style.setProperty('max-height', 'none', 'important');
          parent.style.setProperty('height', 'auto', 'important');
          parent.style.setProperty('overflow-y', 'visible', 'important');
          parent.style.setProperty('overflow', 'visible', 'important');
        }
        parent = parent.parentElement;
        hops++;
      }

      document.documentElement.style.setProperty('overflow-y', 'visible', 'important');
      document.body.style.setProperty('overflow-y', 'visible', 'important');
      document.body.style.setProperty('height', 'auto', 'important');
      document.body.style.setProperty('max-height', 'none', 'important');
    }, geometry.marker).catch(() => {});
  }

  async function captureHighResolutionFullPage(filename, scaleFactor = 2) {
    // Paywalls often keep the document itself at one viewport tall and put the
    // pricing content inside a nested scroll container. Playwright fullPage only
    // expands the document, so those pages otherwise produce a 390x844 viewport
    // screenshot even though much more paywall content exists below it.
    const originalViewport = page.viewportSize() || { width: 390, height: 844 };
    let cdp = null;
    try {
      let geometry = await measurePaywallCaptureGeometry();
      await primePaywallLazyContent(geometry);

      const initialCaptureHeight = Math.max(
        originalViewport.height,
        Math.ceil(geometry.captureHeight || geometry.rootHeight || originalViewport.height)
      );

      if (geometry.marker) {
        console.log(`Paywall uses an internal scroll container (${geometry.internalClientHeight}px visible / ${geometry.internalScrollHeight}px total). Expanding it for a complete capture.`);
      } else {
        console.log(`Paywall document height detected: ${initialCaptureHeight}px.`);
      }

      cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: originalViewport.width,
        height: Math.min(initialCaptureHeight, 12000),
        deviceScaleFactor: scaleFactor,
        mobile: false,
        screenWidth: originalViewport.width,
        screenHeight: Math.min(initialCaptureHeight, 12000)
      });

      await page.waitForTimeout(450);
      await unclipPaywallScrollContainer(geometry);
      await page.waitForTimeout(500);
      await prepareFullPageCapture();

      // Re-measure after the tall viewport and unclipping pass. Some SPAs switch
      // from an 844px shell to their real content height only after this reflow.
      const finalHeight = await page.evaluate(() => Math.max(
        window.innerHeight,
        document.documentElement?.scrollHeight || 0,
        document.body?.scrollHeight || 0,
        ...Array.from(document.querySelectorAll('[data-crawler-paywall-scroll-root]')).map(el => el.scrollHeight + Math.max(0, el.getBoundingClientRect().top))
      )).catch(() => initialCaptureHeight);

      const boundedFinalHeight = Math.min(12000, Math.max(initialCaptureHeight, Math.ceil(finalHeight)));
      if (boundedFinalHeight > initialCaptureHeight + 20) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: originalViewport.width,
          height: boundedFinalHeight,
          deviceScaleFactor: scaleFactor,
          mobile: false,
          screenWidth: originalViewport.width,
          screenHeight: boundedFinalHeight
        });
        await page.waitForTimeout(350);
      }

      await page.screenshot({ path: filename, fullPage: true, scale: 'device' });
      console.log(`Re-captured complete paywall at ${scaleFactor}x device resolution (${originalViewport.width}px CSS width, up to ${boundedFinalHeight}px CSS height): ${filename}`);
      return true;
    } catch (error) {
      console.log('High-resolution full-length paywall capture failed; keeping the normal screenshot:', error?.message || error);
      return false;
    } finally {
      if (cdp) await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    }
  }

  // SAFETY: the primary page remains forward-only. Conditional-answer testing
  // happens only in disposable browser contexts cloned from the current checkpoint.
  const ISOLATED_BRANCH_PROBING_ENABLED = true;

  const MAX_SCREENS = 100;
  const numberedPageHistory = new Map();
  let lastNumberedFingerprint = '';
  let lastNumberedUrl = '';

  for (let screenNumber = 1; screenNumber <= MAX_SCREENS; screenNumber++) {
    await waitForVisualSettle();
    await dismissBlockingConsentOverlay();
    await silenceMedia();
    let state = await inspectPage();

    if (skipNextNumberedFingerprint) {
      const currentFingerprint = normalizeContextText(state.pageText);
      if (currentFingerprint === skipNextNumberedFingerprint) {
        console.log('Current page was already captured as a conditional lettered screenshot. Advancing before assigning the next numbered screenshot.');
        const advancedPast = await advancePastCapturedTransition(state);
        skipNextNumberedFingerprint = null;
        if (!advancedPast) {
          console.log('Could not safely advance past the already-captured transition. Stopping to avoid a duplicate numbered screenshot.');
          break;
        }
        await waitForVisualSettle();
        state = await inspectPage();
      } else {
        skipNextNumberedFingerprint = null;
      }
    }

    const numberedFingerprint = normalizeContextText(state.pageText || '');
    const numberedUrl = sanitizeUrl(page.url());
    const numberedKey = `${numberedUrl}::${numberedFingerprint}`;
    const previousScreen = numberedPageHistory.get(numberedKey);
    if (previousScreen && previousScreen < screenNumber - 1) {
      console.log(`RESET GUARD: current page matches previously captured screen ${String(previousScreen).padStart(2, '0')}. The funnel appears to have jumped backward/reset. Stopping before creating duplicate screenshots.`);
      break;
    }

    // Same URL is normal for SPAs, so only treat an exact prior URL+content state as
    // a reset. Consecutive identical states are allowed to reach the normal
    // no-advancement check below rather than being mislabeled as a reset.
    if (numberedFingerprint) numberedPageHistory.set(numberedKey, screenNumber);
    lastNumberedFingerprint = numberedFingerprint;
    lastNumberedUrl = numberedUrl;

    let paywallState = await inspectPaywallState();
    const filename = path.join(OUTPUT_DIR, `${String(screenNumber).padStart(2, '0')}.png`);

    // If this is a paywall, clear temporary promo/discount dialogs before the
    // numbered screenshot. Otherwise both the ordinary capture and the later 2x
    // high-resolution capture would preserve the obstruction and hide pricing.
    if (paywallState.isPagePaywall) {
      const dismissedPaywallPopup = await dismissPaywallObscuringPopup();
      if (dismissedPaywallPopup) {
        await page.waitForTimeout(500);
        await waitForVisualSettle();
        await silenceMedia();
        state = await inspectPageNavigationSafe('paywall after popup dismissal');
        paywallState = await inspectPaywallState();
      }
    }

    // Completed-plan and intermediate reveal screens can animate charts or
    // content into place after the first DOM/text snapshot is stable.
    // Apply a dedicated 3s hold only to recognizable visual transition pages.
    if (!paywallState.isPagePaywall && (
      /\b(?:your (?:personalized |personalised )?plan is ready|(?:learning|fitness|weight loss) growth|building your plan|plan is (?:almost )?ready)\b/i.test(state.pageText || '') ||
      (isPassiveTransitionScreen(state.pageText || '') &&
        !(await hasVisibleEditableInput()) && (state.group?.length || 0) === 0)
    )) {
      console.log('Animated transition page detected. Waiting 3 seconds before screenshot.');
      await page.waitForTimeout(3000);
      state = await inspectPageNavigationSafe('animated transition after 3s').catch(() => state);
    }
    await prepareFullPageCapture();
    await page.screenshot({ path: filename, fullPage: true });
    registerBaseScreenshot(screenNumber, filename);
    currentNumberedCaptureSignature = pageSignature(state);
    console.log(`\nCaptured ${filename}`);
    console.log({
      url: sanitizeUrl(page.url()),
      CTA: state.cta?.text || null,
      answerOptions: state.group.map(x => x.text)
    });

    if (paywallState.isPagePaywall) {
      console.log('Paywall detected:', paywallState.reason || 'pricing/paywall evidence');
      if (paywallState.crossedPrices.length) console.log('Crossed prices:', paywallState.crossedPrices);
      if (paywallState.currentPrices.length) console.log('Current prices:', paywallState.currentPrices);
      // The ordinary numbered screenshot above establishes the exact page and file
      // name. Overwrite only genuine paywalls with a denser 2x capture so long
      // pages remain readable when enlarged in Figma.
      await captureHighResolutionFullPage(filename, 2);
      console.log(`Captured paywall as high-resolution full-page PNG: ${filename}`);
      console.log('Stopping immediately after paywall capture; no paywall CTA will be clicked.');
      break;
    }

    const beforeSignature = pageSignature(state);
    // pageSignature is intentionally text-centric. Some SPA funnels reveal a
    // numeric/text input without changing visible body text, so remember whether
    // an editable field already existed before the interaction. This lets the
    // outer loop distinguish "nothing changed" from "a real form step appeared".
    const beforeHadEditableInput = await hasVisibleEditableInput();
    let acted = false;
    let interactionHandledBySpecialCase = false;

    // Read explicit page intent before generic branch exploration. A page whose
    // title/subtitle says to choose/select an age is a direct selection task, not
    // a conditional-branch experiment. We consistently choose the range containing 25.
    const explicitAgeChoice = await handleExplicitAgeSelection(state);
    if (explicitAgeChoice.handled) {
      interactionHandledBySpecialCase = true;
      acted = explicitAgeChoice.advanced;
    } else {
      // Evaluation/loading screens can contain a small answer gate (for example
      // Yes/No reminders) that merely resumes the ongoing calculation. Never run
      // branch exploration on those controls.
      const passiveGate = await handlePassiveEvaluationGate(state);
      if (passiveGate.handled) {
        interactionHandledBySpecialCase = true;
        acted = passiveGate.advanced;
      } else if (ISOLATED_BRANCH_PROBING_ENABLED && state.group.length >= 2 && !isSpeechInputScreen(state.pageText) && !hasSkipEscapeChoice(state)) {
        // Probe alternates without mutating the live page. Keep acted=false so the
        // untouched primary page then advances once on its normal path.
        await exploreAnswerBranchesIsolated(state, screenNumber);
      } else if (state.group.length >= 2 && isSpeechInputScreen(state.pageText)) {
        console.log('Branch exploration skipped because this page genuinely requests spoken/audio input.');
      }
    }
    if (!acted && !interactionHandledBySpecialCase) {
      const refreshedState = await inspectPage();
      acted = await advanceOneScreen(refreshedState, screenNumber);
    }
    if (!acted) {
      console.log('No safe interaction pattern detected. Stopping.');
      break;
    }
    const afterState = await inspectPage();
    const afterSignature = pageSignature(afterState);
    if (afterSignature === beforeSignature) {
      const afterHasEditableInput = await hasVisibleEditableInput();
      if (!beforeHadEditableInput && afterHasEditableInput) {
        // A real form step appeared even though its heading/body text reused the
        // prior SPA shell. Do NOT stop here. Let the next numbered iteration
        // screenshot that form first, then advanceOneScreen will run the semantic
        // profile handler (height 180 cm, current weight variants ending at 80 kg,
        // goal weight variants ending at 70 kg, age 25) or the generic form handler.
        console.log('Editable form input appeared without a text-signature change. Treating this as real page advancement and continuing so the form can be captured and handled.');
        continue;
      }
      console.log('No page advancement detected. Stopping safely.');
      break;
    }
    if (screenNumber === MAX_SCREENS) {
      console.log(`Reached safety cap of ${MAX_SCREENS} screens. Stopping crawler.`);
      break;
    }
  }

  await browser.close();
  console.log('Crawler finished.');
}

if (require.main === module) runCrawler().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
module.exports = { getAgeQuestionEvidence, shouldDeferAgeSelectionToForm, shouldFollowProfileContinue,
  createRunCredentials, genericFormFieldType, isEmailRejection, redactCrawlerLog };

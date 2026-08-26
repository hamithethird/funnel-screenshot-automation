const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

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
    /\balmost (?:done|ready|there)\b/,
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

function sanitizeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return rawUrl || '';
  }
}

(async () => {
  const url = process.argv[2];
  if (!url) {
    console.error('Please provide a URL.');
    process.exit(1);
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

  const OUTPUT_DIR = createRunOutputDirectory(url);
  console.log('Saving screenshots to:', OUTPUT_DIR);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(url, { waitUntil: 'networkidle' });

  function generateRandomAsciiString(length = 16) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return result;
  }

  const RUN_EMAIL = `${generateRandomAsciiString(16)}@gmail.com`;

  function generateRunPassword(length = 16) {
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const digits = '0123456789';
    const all = lowercase + uppercase + digits;
    const chars = [
      uppercase[Math.floor(Math.random() * uppercase.length)],
      digits[Math.floor(Math.random() * digits.length)],
      lowercase[Math.floor(Math.random() * lowercase.length)]
    ];
    while (chars.length < Math.max(length, 8)) {
      chars.push(all[Math.floor(Math.random() * all.length)]);
    }
    for (let i = chars.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  }

  const RUN_PASSWORD = generateRunPassword(16);
  const supplementalCounterByScreen = new Map();
  const supplementalFingerprintsByScreen = new Map();
  let skipNextNumberedFingerprint = null;

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
    const overlaySelectors = [
      '[role="dialog"]', '[aria-modal="true"]', '.cky-modal', '.cky-modal-open',
      '[class*="cookie"]', '[id*="cookie"]', '[class*="consent"]', '[id*="consent"]'
    ];
    const affirmativePatterns = [
      /^accept all$/i, /^accept$/i, /^allow all$/i, /^allow$/i, /^agree$/i, /^i agree$/i,
      /^consent$/i, /^ok$/i, /^okay$/i, /^got it$/i, /^tümünü kabul et$/i, /^kabul et$/i,
      /^hepsini kabul et$/i, /^izin ver$/i, /^aceptar todo$/i, /^aceptar$/i, /^aceitar tudo$/i,
      /^aceitar$/i, /^tout accepter$/i, /^accepter$/i, /^alle akzeptieren$/i, /^akzeptieren$/i,
      /^accetta tutto$/i, /^accetta$/i
    ];
    const overlays = page.locator(overlaySelectors.join(','));
    const overlayCount = await overlays.count();
    for (let i = 0; i < overlayCount; i++) {
      const overlay = overlays.nth(i);
      if (!(await overlay.isVisible().catch(() => false))) continue;
      const actions = overlay.locator('button, [role="button"], input[type="button"], input[type="submit"], a');
      const actionCount = await actions.count();
      for (let j = 0; j < actionCount; j++) {
        const action = actions.nth(j);
        if (!(await action.isVisible().catch(() => false))) continue;
        const text = (
          (await action.innerText().catch(() => '')) ||
          (await action.getAttribute('aria-label')) ||
          (await action.getAttribute('value')) || ''
        ).trim().replace(/\s+/g, ' ');
        if (!affirmativePatterns.some(pattern => pattern.test(text))) continue;
        console.log('Blocking consent modal detected. Dismissing with:', text);
        try {
          await action.click({ timeout: 5000 });
        } catch {
          continue;
        }
        await page.waitForTimeout(500);
        if (!(await overlay.isVisible().catch(() => false))) {
          console.log('Blocking consent modal dismissed.');
          return true;
        }
      }
    }
    return false;
  }

  async function safeCrawlerClick(locator, description = 'target') {
    await dismissBlockingConsentOverlay();
    await silenceMedia();
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

  await dismissBlockingConsentOverlay();
  await silenceMedia();

  async function handleScratchReveal(screenNumber, state) {
    const probe = await page.evaluate(() => {
      const normalize = value => (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const bodyText = normalize(document.body.innerText || '');
      const scratchWords = /\b(scratch|scratch to reveal|scratch here|reveal your|reveal discount|reveal offer|reveal prize|uncover|rub to reveal)\b/i;
      const pageSuggestsScratch = scratchWords.test(bodyText);
      const candidates = Array.from(document.querySelectorAll('canvas, [class*="scratch" i], [id*="scratch" i], [aria-label*="scratch" i], [class*="reveal" i], [id*="reveal" i], [aria-label*="reveal" i], [class*="prize" i], [id*="prize" i]'));
      const visible = candidates.map((el, index) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const ok = rect.width >= 120 && rect.height >= 70 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
        if (!ok) return null;
        const attrs = normalize([el.id, el.className && String(el.className), el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' '));
        let score = 0;
        if (scratchWords.test(attrs)) score += 120;
        if (el.tagName.toLowerCase() === 'canvas') score += 35;
        if (pageSuggestsScratch) score += 60;
        if (rect.width >= window.innerWidth * 0.45) score += 20;
        return { index, score };
      }).filter(Boolean).sort((a, b) => b.score - a.score);
      if (!visible.length || visible[0].score < 60) return null;
      const target = candidates[visible[0].index];
      const id = `crawler-scratch-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
      target.setAttribute('data-crawler-scratch-id', id);
      return { id, score: visible[0].score };
    });

    if (!probe) return { handled: false, advanced: false };
    console.log('Scratch/reveal interaction detected. Attempting to uncover the hidden offer.');

    const beforeState = state || await inspectPage();
    const beforeSignature = pageSignature(beforeState);
    const target = page.locator(`[data-crawler-scratch-id="${probe.id}"]`);
    const box = await target.boundingBox().catch(() => null);
    if (!box) return { handled: true, advanced: false };

    const left = box.x + box.width * 0.12;
    const right = box.x + box.width * 0.88;
    const top = box.y + box.height * 0.18;
    const bottom = box.y + box.height * 0.82;
    const rows = 7;

    try {
      for (let row = 0; row < rows; row++) {
        const y = top + ((bottom - top) * row / Math.max(rows - 1, 1));
        const startX = row % 2 === 0 ? left : right;
        const endX = row % 2 === 0 ? right : left;
        await page.mouse.move(startX, y);
        await page.mouse.down();
        await page.mouse.move(endX, y, { steps: 18 });
        await page.mouse.up();
        await page.waitForTimeout(80);
      }
    } catch (error) {
      console.log('Scratch gesture failed:', String(error?.message || error).split('\n')[0]);
      return { handled: true, advanced: false };
    }

    await page.waitForTimeout(900);
    await waitForScreenshotReady({ minimumWaitMs: 700, maxWaitMs: 2600, pollMs: 250 });
    const afterState = await inspectPage();
    const changed = pageSignature(afterState) !== beforeSignature;

    if (screenNumber !== null && changed) {
      await captureSupplementalState(screenNumber, afterState, 'scratch/reveal completed', [], 0.99);
    }

    const navigationResult = await clickStrongNavigation(afterState, 'post-scratch navigation CTA');
    if (navigationResult.handled) return navigationResult;
    return { handled: true, advanced: changed };
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
    await page.waitForTimeout(700);
    let afterState = await inspectPage();
    if (pageSignature(afterState) !== beforeSignature) {
      console.log('English language selected.');
      if (afterState.cta) {
        const beforeCTA = pageSignature(afterState);
        const ctaClicked = await safeCrawlerClick(page.locator(`[data-auto-id="${afterState.cta.id}"]`), afterState.cta.text || 'language-choice CTA');
        if (ctaClicked) await waitForAdvancement(beforeCTA, 7000);
      }
      return true;
    }
    afterState = await inspectPage();
    if (afterState.cta) {
      const ctaClicked = await safeCrawlerClick(page.locator(`[data-auto-id="${afterState.cta.id}"]`), afterState.cta.text || 'language-choice CTA');
      return ctaClicked;
    }
    return true;
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
      const hasPlanPricingPaywall = hasPlanReadyLanguage && hasPricingLanguage && (current.length >= 1 || hasPurchaseLanguage);
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
      for (const item of controls) {
        if (item.answerControl || answerIds.has(item.id)) continue;
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
    const fields = page.locator('input:not([type]), input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="tel"], input[type="url"], textarea');
    const count = await fields.count();
    for (let i = 0; i < count; i++) {
      if (await fields.nth(i).isVisible().catch(() => false)) return true;
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
        if (!escapePattern.test(text)) continue;
        candidates.push({ el, text, area: rect.width * rect.height, top: rect.top, right: window.innerWidth - rect.right });
      }
      if (!candidates.length) return null;
      candidates.sort((a, b) => {
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
          const key = ((candidate.text || '').trim().toLowerCase() || candidate.id);
          return !selectedKeys.has(key);
        });
      }

      if (!option) break;
      const optionKey = ((option.text || '').trim().toLowerCase() || option.id);
      console.log(`Selecting option ${selectedKeys.size + 1}:`, option.text || '[no visible text]');
      const clicked = await safeCrawlerClick(page.locator(`[data-auto-id="${option.id}"]`), option.text || 'answer option');
      if (!clicked) return false;
      selectedKeys.add(optionKey);
      await page.waitForTimeout(650);

      let afterSelection = await inspectPageNavigationSafe('answer selection inspection');
      const samePageSelectionState = sanitizeUrl(page.url()) === initialUrl && afterSelection.group.length > 0;
      const contextChanged = normalizeContextText(afterSelection.pageText) !== normalizeContextText(initialState.pageText);
      const originalPrompt = questionPromptFingerprint(initialState);
      const currentPrompt = questionPromptFingerprint(afterSelection);
      const promptStillMatches = !!originalPrompt && !!currentPrompt && contextSimilarity(originalPrompt, currentPrompt) >= 0.86;
      const originalOptions = (initialState.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);
      const currentOptions = (afterSelection.group || []).map(x => (x.text || '').trim().toLowerCase()).filter(Boolean);
      const overlap = originalOptions.filter(text => currentOptions.includes(text)).length;
      const sameAnswerSet = overlap >= Math.max(1, Math.ceil(Math.min(originalOptions.length, currentOptions.length) * 0.6));

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
        console.log('Minimum selection requirement satisfied. Using CTA:', afterSelection.cta.text || '(no text)');
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
        console.log('Single-select page has no explicit Continue CTA and neither the nested control nor the containing answer card advanced.');
        return false;
      }

      if (instruction.maxSelections && selectedKeys.size >= instruction.maxSelections) break;
    }

    const finalState = await inspectPage();
    if (selectedKeys.size >= minSelections && finalState.cta) {
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
    const passiveTransition = isPassiveTransitionScreen(initialState.pageText);
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
      const actionable = visibleEditableInput || state.group.length > 0 || state.cta !== null || isNativeLanguageQuestion(state.pageText) || isSpeechInputScreen(state.pageText) || hasSkipEscapeChoice(state);

      if (actionable) {
        if (passiveTransition) console.log(visibleEditableInput ? 'Passive transition completed: editable form input appeared.' : 'Passive transition completed: actionable screen appeared.');
        return { state, changed: signature !== initialSignature || visibleEditableInput };
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

  async function handleRequiredAgreementCheckboxes(input) {
    const legalPattern = /\b(terms?|conditions?|privacy|policy|legal|agreement)\b/i;
    const acceptancePattern = /\b(accept|agree|consent)\b/i;
    const marketingPattern = /\b(news|newsletter|updates?|offers?|promotions?|marketing|communications?)\b/i;
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
      const isLegalAgreement = legalPattern.test(info.text) && (acceptancePattern.test(info.text) || info.required);
      const isMarketingOnly = marketingPattern.test(info.text) && !legalPattern.test(info.text);
      if (!isLegalAgreement || isMarketingOnly) continue;
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
      const selectors = [
        'h1', 'h2', 'h3', '[role="heading"]',
        'label', 'legend', '[aria-label]'
      ];
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          if (!visible(el)) continue;
          const text = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
          if (!text || text.length > 220) continue;
          parts.push(text);
        }
      }
      return normalize(parts.join(' ')).slice(0, 1200);
    }).catch(() => '');
  }

  async function handleProfileNumericInput(state, screenNumber = null) {
    const pageText = (state?.pageText || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!pageText) return { recognized: false, advanced: false };

    // SPA funnels can keep stale prior-step text in the DOM. Numeric profile
    // classification therefore uses the currently visible heading/label intent
    // first, rather than broad body text from previous screens.
    const visibleIntent = (await getVisibleFormIntentText()).toLowerCase().replace(/\s+/g, ' ').trim();
    const semanticText = visibleIntent || pageText;

    // Explicit non-numeric form intent must win over stale numeric words left in
    // the DOM. This prevents a "What's your name?" screen from inheriting the
    // previous weight screen's value/logic.
    if (/\bwhat(?:'s| is) your name\b|\benter (?:your )?name\b|\byour name\b/i.test(visibleIntent)) {
      return { recognized: false, advanced: false };
    }

    let profileType = null;
    if (/\b(goal|target|desired)\s+weight\b|what(?:'s| is) your goal weight|goal weight/i.test(semanticText)) {
      profileType = 'goal-weight';
    } else if (/\bcurrent\s+weight\b|what(?:'s| is) your current weight\b|\bhow much do you weigh\b/i.test(semanticText)) {
      profileType = 'current-weight';
    } else if (/\bhow tall are you\b|\byour height\b|\bheight\b/i.test(semanticText)) {
      profileType = 'height';
    } else if (/\bhow old are you\b|\byour age\b|\bage\b/i.test(semanticText)) {
      profileType = 'age';
    }
    if (!profileType) return { recognized: false, advanced: false };

    const fields = page.locator(
      'input:not([type]), input[type="text"], input[type="number"], input[type="tel"], input[inputmode="numeric"], input[inputmode="decimal"]'
    );
    const count = await fields.count();
    const editable = [];
    for (let i = 0; i < count; i++) {
      const field = fields.nth(i);
      if (!(await field.isVisible().catch(() => false))) continue;
      if (!(await field.isEnabled().catch(() => false))) continue;
      if (!(await field.isEditable().catch(() => false))) continue;
      editable.push(field);
    }
    if (!editable.length) return { recognized: false, advanced: false };

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
      await field.fill(String(value));
      await field.evaluate(el => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
      });
      await page.waitForTimeout(700);
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

  async function handleGenericFormInput(state) {
    const visibleFormIntent = (await getVisibleFormIntentText()).toLowerCase().replace(/\s+/g, ' ').trim();
    const fields = page.locator(
      'input:not([type]), input[type="text"], input[type="email"], input[type="password"], textarea'
    );
    const count = await fields.count();
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
      const signals = [info.name, info.placeholder, info.autocomplete, info.ariaLabel, info.label, visibleFormIntent].join(' ');
      let fieldType = null;
      let value = null;
      if (info.type === 'email' || info.autocomplete === 'email' || /\be-?mail\b/i.test(signals)) {
        fieldType = 'email';
        value = RUN_EMAIL;
      } else if (
        info.type === 'password' || ['new-password', 'current-password'].includes(info.autocomplete) ||
        /\b(password|passcode|create[\s_-]*password|confirm[\s_-]*password)\b/i.test(signals)
      ) {
        fieldType = 'password';
        value = RUN_PASSWORD;
      } else if (
        ['name', 'given-name', 'first-name'].includes(info.autocomplete) ||
        /\b(first[\s_-]*name|your[\s_-]*name|name)\b/i.test(signals)
      ) {
        fieldType = 'name';
        value = 'Alex';
      }
      if (!value) continue;
      console.log(`Detected ${fieldType} input.`);
      await input.fill(value);
      if (fieldType === 'password') {
        const passwordState = await input.evaluate(el => ({
          length: el.value.length,
          valid: el.validity ? el.validity.valid : null,
          validationMessage: el.validationMessage || ''
        }));
        console.log('PASSWORD DEBUG - generated password length:', passwordState.length);
        console.log('PASSWORD DEBUG - browser validity:', passwordState.valid);
        console.log('PASSWORD DEBUG - validation message:', passwordState.validationMessage || '(none)');
      }
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
          if (submittedByClick && await waitForAdvancement(beforeSignature)) return { recognized: true, advanced: true };
        }
        const submitted = await input.evaluate(el => {
          const formEl = el.closest('form');
          if (!formEl) return false;
          formEl.requestSubmit();
          return true;
        });
        if (submitted && await waitForAdvancement(beforeSignature)) return { recognized: true, advanced: true };
      }
      const nearbyAction = await findBottomPrimaryFormAction(input);
      if (nearbyAction) {
        const termsBeforeNearbyAction = await handleRequiredAgreementCheckboxes(input);
        if (!termsBeforeNearbyAction.active) return { recognized: true, advanced: false };
        const clicked = await safeCrawlerClick(nearbyAction.locator, nearbyAction.text || 'bottom primary CTA');
        if (clicked && await waitForAdvancement(beforeSignature)) return { recognized: true, advanced: true };
      }
      const termsBeforeEnter = await handleRequiredAgreementCheckboxes(input);
      if (!termsBeforeEnter.active) return { recognized: true, advanced: false };
      console.log(`Trying Enter for ${fieldType} input.`);
      await input.press('Enter');
      if (await waitForAdvancement(beforeSignature)) return { recognized: true, advanced: true };
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
    try {
      const backCandidate = await evaluateNavigationSafe(() => {
        const selectors = 'button, [role="button"], a, [onclick], [tabindex]';
        const elements = Array.from(document.querySelectorAll(selectors));
        const visible = el => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
            r.top < window.innerHeight && r.left < window.innerWidth &&
            s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 &&
            s.pointerEvents !== 'none';
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
          const topLeftArrow = r.left <= Math.max(90, window.innerWidth * 0.24) &&
            r.top <= Math.max(130, window.innerHeight * 0.18) &&
            r.width <= 100 && r.height <= 100 &&
            !!el.querySelector('svg, img');
          if (!semanticBack && !topLeftArrow) continue;
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
          candidates.push({ id, semanticBack, topLeftArrow, top: r.top, left: r.left });
        }
        candidates.sort((a, b) => {
          if (a.semanticBack !== b.semanticBack) return a.semanticBack ? -1 : 1;
          if (a.top !== b.top) return a.top - b.top;
          return a.left - b.left;
        });
        return candidates[0] || null;
      });

      if (backCandidate?.id) {
        console.log('Restoring branch question with the funnel\'s own Back control.');
        const clicked = await safeCrawlerClick(
          page.locator(`[data-auto-id="${backCandidate.id}"]`),
          'funnel Back control'
        );
        if (clicked) {
          // The funnel Back control may trigger a real document navigation. Wait for
          // that navigation to settle before any DOM inspection is attempted.
          await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
          await page.waitForTimeout(450);
          const matched = await inspectAndMatch(500);
          if (matched) return matched;
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

    // Direct navigation is the last resort only. It is accepted only if the exact
    // original question prompt + answer set can be verified after loading.
    try {
      console.log('Browser history did not restore the question. Trying the saved question URL as a last resort.');
      await page.goto(questionUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const matched = await inspectAndMatch(1000);
      if (matched) return matched;
    } catch {}

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

  function branchProbeIndexes(optionCount, maxProbe = 4) {
    if (optionCount <= maxProbe) return Array.from({ length: optionCount }, (_, i) => i);
    const raw = [0, optionCount - 1, Math.round((optionCount - 1) / 3), Math.round(((optionCount - 1) * 2) / 3)];
    const unique = [];
    for (const index of raw) if (!unique.includes(index)) unique.push(index);
    return unique.slice(0, maxProbe);
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
    if (instruction.minSelections !== 1 || instruction.maxSelections !== 1) return false;

    const optionTexts = state.group.map(x => (x.text || '').trim()).filter(Boolean);
    if (optionTexts.length < 2) return false;

    const questionUrl = page.url();
    const questionState = state;
    const questionFingerprint = questionPromptFingerprint(questionState);
    const outcomes = [];
    const probedIndexes = branchProbeIndexes(optionTexts.length, 4);
    console.log(`Probing up to ${probedIndexes.length} strategically spread answers to determine whether this question has conditional next pages.`);

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
      if (!restored) return false;
      const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
      return finalResult.advanced;
    }

    let probeFingerprints = new Set(outcomes.map(x => x.fingerprint));

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
      probeFingerprints = new Set(outcomes.map(x => x.fingerprint));
    }

    const testedIndexes = new Set(outcomes.map(x => x.index));
    const unresolvedIndexes = probedIndexes.filter(index => !testedIndexes.has(index));

    if (probeFingerprints.size <= 1 && unresolvedIndexes.length === 0) {
      console.log(`Branch probe result: all ${outcomes.length} successfully tested answers lead to the same immediate next page. No conditional branch detected.`);
      const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
      if (!restored) return false;
      const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
      return finalResult.advanced;
    }

    if (probeFingerprints.size <= 1 && unresolvedIndexes.length > 0) {
      console.log('No different transition was proven, but at least one probe remained unresolved. Continuing on the normal path without creating conditional screenshots.');
      const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
      if (!restored) return false;
      const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
      return finalResult.advanced;
    }

    console.log(`Conditional branching confirmed: ${probeFingerprints.size} different immediate next pages found in the successful probes.`);
    console.log('Branching is confirmed, so the crawler will now test the remaining answers to collect all unique transition pages.');

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

    const uniqueOutcomes = [];
    for (const outcome of outcomes) {
      let existing = uniqueOutcomes.find(item => item.fingerprint === outcome.fingerprint);
      if (!existing) {
        existing = { ...outcome, answers: [outcome.optionText] };
        uniqueOutcomes.push(existing);
      } else {
        existing.answers.push(outcome.optionText);
      }
    }

    if (uniqueOutcomes.length <= 1) {
      console.log('After full comparison, all answers collapsed to one unique next page. No conditional screenshots will be created.');
      const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
      if (!restored) return false;
      const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
      return finalResult.advanced;
    }

    console.log(`Saving ${uniqueOutcomes.length} unique conditional next pages as lettered screenshots.`);
    for (let i = 0; i < uniqueOutcomes.length; i++) {
      const filename = path.join(OUTPUT_DIR, `${String(screenNumber).padStart(2, '0')}${branchLetter(i)}.png`);
      fs.writeFileSync(filename, uniqueOutcomes[i].screenshotBuffer);
      console.log(`Captured ${path.basename(filename)} for answer(s): ${uniqueOutcomes[i].answers.join(' | ')}`);
    }

    const restored = await restoreQuestionPage(questionUrl, optionTexts, questionFingerprint);
    if (!restored) {
      console.log('Conditional pages were captured, but the main question could not be restored safely.');
      return false;
    }

    const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
    if (!finalResult.advanced || !finalResult.landingState) return false;
    const mainFingerprint = normalizeContextText(finalResult.landingState.pageText);
    if (uniqueOutcomes.some(item => item.fingerprint === mainFingerprint)) {
      skipNextNumberedFingerprint = mainFingerprint;
      console.log('Main path is currently on a transition already captured as a lettered screenshot; the next numbered capture will skip over it.');
    }
    return true;
  }

  async function handleExplicitAgeSelection(state) {
    const pageText = (state?.pageText || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!pageText) return { handled: false, advanced: false };

    // Read the page intent before treating visible cards as generic answer choices.
    // Only activate this handler when the title/subtitle explicitly asks for age.
    const explicitAgeIntent = /\b(?:choose|select|pick)\s+(?:your\s+)?age\b|\bchoose\s+your\s+age\b|\bhow\s+old\s+are\s+you\b|\b(?:your\s+)?age\s+(?:group|range)\b/i.test(pageText);
    if (!explicitAgeIntent) return { handled: false, advanced: false };

    const targetAge = 25;
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
        const under = t.match(/(?:under|below|less than)\s*(\d{1,3})/i);
        if (under) return targetAge < Number(under[1]);
        const over = t.match(/(?:over|above|older than)\s*(\d{1,3})/i);
        if (over) return targetAge > Number(over[1]);
        const exact = t.match(/(?:age\s*[:\-]?\s*)?(\d{1,3})\b/i);
        return !!exact && Number(exact[1]) === targetAge;
      };
      const looksLikeAgeChoice = text => /(?:age\s*[:\-]?\s*)?\d{1,3}\s*(?:[-–—]\s*\d{1,3}|\+)?|(?:under|below|over|above|older than|less than)\s*\d{1,3}/i.test(normalize(text));

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
      console.log('Age-selection intent detected, but no reachable option containing age 25 was found.');
      return { handled: true, advanced: false };
    }

    console.log(`Age-selection page detected from title/subtitle. Choosing the option that contains age ${targetAge}:`, candidate.text);
    const beforeState = await inspectPageNavigationSafe('age choice pre-click');
    const beforeSignature = pageSignature(beforeState);
    const clicked = await safeCrawlerClick(
      page.locator(`[data-crawler-age-choice-id="${candidate.id}"]`),
      `age option ${candidate.text}`
    );
    if (!clicked) return { handled: true, advanced: false };

    if (await waitForAdvancement(beforeSignature, 12000)) {
      return { handled: true, advanced: true };
    }

    // Some funnels only select the card first and reveal/enable a Continue CTA.
    const afterSelection = await inspectPageNavigationSafe('age choice post-click');
    const nav = await clickStrongNavigation(afterSelection, 'age selection navigation CTA');
    if (nav.handled) return { handled: true, advanced: nav.advanced };

    return { handled: true, advanced: false };
  }

  async function handlePassiveEvaluationGate(state) {
    // Some evaluation/loading screens pause their automatic progress to ask a
    // lightweight Yes/No-style question. This is not a branch question: the
    // answer only unlocks/resumes the same passive evaluation sequence.
    if (!state || state.group.length < 2) {
      return { handled: false, advanced: false };
    }

    const normalizedPageText = (state.pageText || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const hasProgressPercent = /\b(?:[1-9]?\d|100)%\b/.test(normalizedPageText);
    const evaluationLanguage = /\b(matching|analyzing|analysing|processing|loading|calculating|assessing|evaluating|scoring|preparing|building|creating|generating|personalizing|personalising|tailoring|compiling)\b/.test(normalizedPageText);
    const evaluationGateContext = isPassiveTransitionScreen(state.pageText) || (hasProgressPercent && evaluationLanguage);
    if (!evaluationGateContext) {
      return { handled: false, advanced: false };
    }

    const instruction = getSelectionInstruction(state.pageText);
    if ((instruction.minSelections || 1) !== 1 || (instruction.maxSelections !== null && instruction.maxSelections !== 1)) {
      return { handled: false, advanced: false };
    }

    const optionTexts = state.group.map(item => (item.text || '').trim()).filter(Boolean);
    const shortChoiceGate = optionTexts.length <= 4 && optionTexts.every(text => text.length <= 80);
    if (!shortChoiceGate) return { handled: false, advanced: false };

    console.log('Passive evaluation gate detected. Selecting one answer to resume the evaluation; branch exploration is intentionally skipped.');
    const beforeSignature = pageSignature(state);
    const beforeUrl = sanitizeUrl(page.url());
    const option = state.group[0];
    const clicked = await safeCrawlerClick(
      page.locator(`[data-auto-id="${option.id}"]`),
      option.text || 'passive evaluation answer'
    );
    if (!clicked) return { handled: true, advanced: false };

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

  async function advanceOneScreen(state, screenNumber = null) {
    const handledEnglishLanguageChoice = await handleEnglishLanguageChoice();
    if (handledEnglishLanguageChoice) return true;
    if (isNativeLanguageQuestion(state.pageText)) {
      const handledCustomLanguage = await handleCustomNativeLanguage(state);
      if (handledCustomLanguage) return true;
    }
    const skippedOptionalInput = await handleSkippableInputRequirement(state);
    if (skippedOptionalInput) return true;

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

  const MAX_SCREENS = 100;
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

    const paywallState = await inspectPaywallState();
    const filename = path.join(OUTPUT_DIR, `${String(screenNumber).padStart(2, '0')}.png`);
    await page.screenshot({ path: filename, fullPage: true });
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
      console.log(`Captured paywall as full-page PNG: ${filename}`);
      console.log('Stopping immediately after paywall capture; no paywall CTA will be clicked.');
      break;
    }

    const beforeSignature = pageSignature(state);
    let acted = false;

    // Read explicit page intent before generic branch exploration. A page whose
    // title/subtitle says to choose/select an age is a direct selection task, not
    // a conditional-branch experiment. We consistently choose the range containing 25.
    const explicitAgeChoice = await handleExplicitAgeSelection(state);
    if (explicitAgeChoice.handled) {
      acted = explicitAgeChoice.advanced;
    } else {
      // Evaluation/loading screens can contain a small answer gate (for example
      // Yes/No reminders) that merely resumes the ongoing calculation. Never run
      // branch exploration on those controls.
      const passiveGate = await handlePassiveEvaluationGate(state);
      if (passiveGate.handled) {
        acted = passiveGate.advanced;
      } else if (state.group.length >= 2 && !isSpeechInputScreen(state.pageText) && !hasSkipEscapeChoice(state)) {
        acted = await exploreAnswerBranches(state, screenNumber);
      } else if (state.group.length >= 2 && isSpeechInputScreen(state.pageText)) {
        console.log('Branch exploration skipped because this page genuinely requests spoken/audio input.');
      }
    }
    if (!acted) {
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
})();

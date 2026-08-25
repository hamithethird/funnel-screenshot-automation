const { chromium } = require('playwright');

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
    /\b(crafting|creating|generating|building|preparing|personalizing|personalising|analyzing|analysing|processing|loading|calculating|finalizing|finalising)\b/,
    /\b(putting together|setting up)\b/,
    /\bplease wait\b/,
    /\balmost (?:done|ready|there)\b/,
    /\bhang tight\b/,
    /\bthis may take (?:a|few|some) (?:moment|moments|second|seconds|minute|minutes)\b/
  ];

  return passiveSignals.some(pattern => pattern.test(normalized));
}

function isSpeechInputScreen(text) {
  const normalized = (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  const speechSignals = [
    /\b(speak|speaking|spoken|say (?:it|this|something)|say aloud|read aloud)\b/,
    /\b(microphone|mic|voice|record|recording|pronunciation)\b/,
    /\b(quick call|ai tutor|voice assessment|speaking assessment|speech assessment)\b/
  ];
  return speechSignals.some(pattern => pattern.test(normalized));
}

const skipEscapePattern = /^(skip|skip for now|not now|maybe later|later|do this later|do it later|continue without(?: this)?|continue without speaking|no thanks|no, thanks|i'll do this later|i will do this later)$/i;

function hasSkipEscapeChoice(state) {
  if (!state) return false;
  const texts = [state.cta?.text || '', ...(state.group || []).map(item => item.text || '')];
  return texts.some(text => skipEscapePattern.test(text.trim()));
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

(async () => {
  const url = process.argv[2];
  if (!url) {
    console.error('Please provide a URL.');
    process.exit(1);
  }

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

  function nextSupplementalFilename(screenNumber) {
    const current = supplementalCounterByScreen.get(screenNumber) || 0;
    supplementalCounterByScreen.set(screenNumber, current + 1);
    return `${String(screenNumber).padStart(2, '0')}${branchLetter(current)}.png`;
  }

  function supplementalFingerprintSeen(screenNumber, fingerprint, threshold = 0.95) {
    const seen = supplementalFingerprintsByScreen.get(screenNumber) || [];
    const match = seen.find(existing => contextSimilarity(existing, fingerprint) >= threshold);
    if (match) return true;
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
      if (!/intercepts pointer events|another element/i.test(message)) throw error;
      console.log('Click blocked while targeting:', description);
      const dismissed = await dismissBlockingConsentOverlay();
      if (!dismissed) throw error;
      console.log('Retrying original click after modal dismissal:', description);
      await locator.click({ timeout: 7000 });
      await silenceMedia();
      return true;
    }
  }

  await dismissBlockingConsentOverlay();
  await silenceMedia();

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
      const isVisible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
          rect.top < window.innerHeight && rect.left < window.innerWidth &&
          style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      };
      const languageForText = text => languageNames.find(name =>
        text === name || text.startsWith(name + ' ') || text.startsWith(name + '|') ||
        text.startsWith(name + '/') || text.startsWith(name + '(')
      ) || null;
      const cardForLabel = labelEl => {
        let el = labelEl;
        let depth = 0;
        let fallback = null;
        while (el && el !== document.body && depth < 6) {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role');
          const substantial = rect.width >= 70 && rect.height >= 38 &&
            rect.width <= window.innerWidth * 0.95 && rect.height <= window.innerHeight * 0.55;
          const explicitInteractive = tag === 'button' || tag === 'a' || tag === 'label' ||
            role === 'button' || role === 'radio' || role === 'option' ||
            el.hasAttribute('onclick') || el.tabIndex >= 0 || style.cursor === 'pointer';
          const hasVisibleBorder =
            parseFloat(style.borderTopWidth || '0') > 0 || parseFloat(style.borderRightWidth || '0') > 0 ||
            parseFloat(style.borderBottomWidth || '0') > 0 || parseFloat(style.borderLeftWidth || '0') > 0;
          if (substantial && explicitInteractive) return el;
          if (substantial && hasVisibleBorder && !fallback) fallback = el;
          el = el.parentElement;
          depth++;
        }
        return fallback;
      };
      const all = Array.from(document.querySelectorAll('body *'));
      const labels = [];
      for (const el of all) {
        if (!isVisible(el)) continue;
        const text = normalize(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '');
        if (!text || text.length > 100) continue;
        const matchedLanguage = languageForText(text);
        if (!matchedLanguage) continue;
        const card = cardForLabel(el);
        if (!card || !isVisible(card)) continue;
        const rect = card.getBoundingClientRect();
        labels.push({ matchedLanguage, text, card, area: rect.width * rect.height });
      }
      const uniqueCards = [];
      const seen = new Set();
      for (const item of labels) {
        if (seen.has(item.card)) continue;
        seen.add(item.card);
        uniqueCards.push(item);
      }
      const distinctLanguages = new Set(uniqueCards.map(x => x.matchedLanguage));
      const englishCandidates = uniqueCards.filter(x => x.matchedLanguage === 'english').sort((a, b) => a.area - b.area);
      if (distinctLanguages.size < 2 || englishCandidates.length === 0) return null;
      const chosen = englishCandidates[0];
      const autoId = `language-choice-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
      chosen.card.setAttribute('data-language-choice-id', autoId);
      return { value: autoId, text: chosen.text, languages: Array.from(distinctLanguages).slice(0, 10) };
    });

    if (!result) return false;
    console.log('Language-choice page detected. Preferring English. Languages found:', result.languages);
    const beforeState = await inspectPage();
    const beforeSignature = pageSignature(beforeState);
    const target = page.locator(`[data-language-choice-id="${result.value}"]`);
    await safeCrawlerClick(target, 'English language option');
    await page.waitForTimeout(700);
    let afterState = await inspectPage();
    if (pageSignature(afterState) !== beforeSignature) {
      console.log('English language selected.');
      if (afterState.cta) {
        const beforeCTA = pageSignature(afterState);
        await safeCrawlerClick(page.locator(`[data-auto-id="${afterState.cta.id}"]`), afterState.cta.text || 'language-choice CTA');
        await waitForAdvancement(beforeCTA, 7000);
      }
      return true;
    }
    afterState = await inspectPage();
    if (afterState.cta) {
      await safeCrawlerClick(page.locator(`[data-auto-id="${afterState.cta.id}"]`), afterState.cta.text || 'language-choice CTA');
      return true;
    }
    return true;
  }

  async function inspectPaywallState() {
    return await page.evaluate(() => {
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
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
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
      return {
        hasDiscountPair, pairOnlyInModal, longPage, documentHeight, documentWidth,
        crossedPrices: crossed.map(x => x.text).slice(0, 5),
        currentPrices: current.map(x => x.text).slice(0, 5),
        isPagePaywall: hasDiscountPair && !pairOnlyInModal && longPage
      };
    });
  }

  async function inspectPage() {
    return await page.evaluate(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      document.querySelectorAll('[data-auto-id]').forEach(el => el.removeAttribute('data-auto-id'));
      const inspectionId = `${Date.now()}-${Math.floor(Math.random() * 1000000000)}`;
      const all = Array.from(document.querySelectorAll('*'));
      const pageText = document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 3000);
      const questionSignals = /\b(select all that apply|choose all that apply|select any|choose any|select one|choose one|pick one|choose\s+\d+|select\s+\d+|pick\s+\d+|or more|at least|which|what(?:'s| is| are| do| would)|how (?:often|do|would|well|much))\b/i;
      const navigationText = /^(continue|next|proceed|submit|done|finish|start|see results?|get started|create account|sign up|go on)$/i;
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
        const id = `${inspectionId}-auto-${index}`;
        el.setAttribute('data-auto-id', id);
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
    return `${page.url()}\n${state.pageText}`;
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
      const elements = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"]'));
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
      console.log('Optional input/assessment screen detected, but no safe skip option was found.');
      return false;
    }

    console.log('Optional input/assessment requirement detected. Using escape option:', result.text);
    const before = pageSignature(state);
    await safeCrawlerClick(page.locator(`[data-skip-input-id="${result.id}"]`), result.text || 'skip input');
    return await waitForAdvancement(before, 12000);
  }

  async function handleCustomNativeLanguage(state) {
    if (!isNativeLanguageQuestion(state.pageText)) return false;
    const textInputs = page.locator('input:not([type]), input[type="text"], input[type="search"]');
    const inputCount = await textInputs.count();
    for (let i = 0; i < inputCount; i++) {
      const input = textInputs.nth(i);
      if (!(await input.isVisible()) || !(await input.isEnabled())) continue;
      console.log('Native-language text input detected.');
      for (const preferredLanguage of ['English', 'Spanish']) {
        await input.click();
        await input.fill('');
        await input.fill(preferredLanguage);
        await page.waitForTimeout(500);
        const candidateIndex = await page.evaluate((wantedLanguage) => {
          const wanted = wantedLanguage.toLowerCase();
          const vh = window.innerHeight;
          const vw = window.innerWidth;
          const candidates = Array.from(document.querySelectorAll('body *')).map((el, index) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
            const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
              rect.top < vh && rect.left < vw && style.display !== 'none' &&
              style.visibility !== 'hidden' && Number(style.opacity) > 0;
            if (!visible || text.toLowerCase() !== wanted) return null;
            return { index, area: rect.width * rect.height };
          }).filter(Boolean).sort((a, b) => a.area - b.area);
          return candidates.length ? candidates[0].index : null;
        }, preferredLanguage);
        if (candidateIndex === null) continue;
        const clicked = await page.evaluate(({ wantedLanguage, candidateIndex }) => {
          const elements = Array.from(document.querySelectorAll('body *'));
          const el = elements[candidateIndex];
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
          const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
            style.visibility !== 'hidden' && Number(style.opacity) > 0;
          if (!visible || text.toLowerCase() !== wantedLanguage.toLowerCase()) return false;
          const clickable = el.closest('button, [role="option"], [role="menuitem"], [role="button"], a, li') || el;
          clickable.click();
          return true;
        }, { wantedLanguage: preferredLanguage, candidateIndex });
        if (!clicked) continue;
        console.log(`Selected preferred native language: ${preferredLanguage}`);
        await page.waitForTimeout(500);
        const afterSelection = await inspectPage();
        if (afterSelection.cta) {
          const beforeCTA = pageSignature(afterSelection);
          await safeCrawlerClick(page.locator(`[data-auto-id="${afterSelection.cta.id}"]`), afterSelection.cta.text || 'answer-group CTA');
          if (await waitForAdvancement(beforeCTA, 10000)) return true;
          return false;
        }
        return true;
      }
    }
    return false;
  }

  async function handleAnswerGroup(state, screenNumber = null) {
    const initialSignature = pageSignature(state);
    const initialState = state;
    const initialUrl = page.url();
    const instruction = getSelectionInstruction(state.pageText);
    const availableAtStart = Math.max(state.group.length, 1);
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

      let option = null;
      if (isNativeLanguageQuestion(state.pageText)) {
        const preferred = choosePreferredNativeLanguage(state.group);
        if (preferred) {
          option = preferred.option;
          console.log(preferred.reason);
        }
      }

      if (!option) {
        option = state.group.find(candidate => {
          const key = ((candidate.text || '').trim().toLowerCase() || candidate.id);
          return !selectedKeys.has(key);
        });
      }

      if (!option) break;
      const optionKey = ((option.text || '').trim().toLowerCase() || option.id);
      console.log(`Selecting option ${selectedKeys.size + 1}:`, option.text || '[no visible text]');
      await safeCrawlerClick(page.locator(`[data-auto-id="${option.id}"]`), option.text || 'answer option');
      selectedKeys.add(optionKey);
      await page.waitForTimeout(650);

      const afterSelection = await inspectPage();
      const samePageSelectionState = page.url() === initialUrl && afterSelection.group.length > 0;
      const contextChanged = normalizeContextText(afterSelection.pageText) !== normalizeContextText(initialState.pageText);
      if (screenNumber !== null && samePageSelectionState && contextChanged && selectedKeys.size >= minSelections) {
        await captureSupplementalState(
          screenNumber,
          afterSelection,
          'post-selection response/popup',
          [option.text],
          0.95
        );
      }

      if (pageSignature(afterSelection) !== initialSignature && !afterSelection.group.length) return true;

      if (selectedKeys.size < minSelections) {
        console.log(`Instruction requires at least ${minSelections}; selected ${selectedKeys.size}. Continuing selections.`);
        continue;
      }

      if (afterSelection.cta) {
        console.log('Minimum selection requirement satisfied. Using CTA:', afterSelection.cta.text || '(no text)');
        const beforeCTA = pageSignature(afterSelection);
        await safeCrawlerClick(
          page.locator(`[data-auto-id="${afterSelection.cta.id}"]`),
          afterSelection.cta.text || 'answer-group CTA'
        );
        if (await waitForAdvancement(beforeCTA, 10000)) return true;
      }

      if (instruction.maxSelections && selectedKeys.size >= instruction.maxSelections) break;
    }

    const finalState = await inspectPage();
    if (selectedKeys.size >= minSelections && finalState.cta) {
      const beforeCTA = pageSignature(finalState);
      await safeCrawlerClick(
        page.locator(`[data-auto-id="${finalState.cta.id}"]`),
        finalState.cta.text || 'answer-group CTA'
      );
      if (await waitForAdvancement(beforeCTA, 10000)) return true;
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
    const initialUrl = page.url();
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
      const actionable = state.group.length > 0 || state.cta !== null || isNativeLanguageQuestion(state.pageText) || isSpeechInputScreen(state.pageText) || hasSkipEscapeChoice(state);

      if (actionable) {
        if (passiveTransition) console.log('Passive transition completed: actionable screen appeared.');
        return { state, changed: signature !== initialSignature };
      }

      if (passiveTransition) {
        const urlChanged = page.url() !== initialUrl;
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
    const metrics = await page.evaluate(() => ({
      scrollY: window.scrollY,
      documentHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      viewportWidth: window.innerWidth
    }));
    const candidates = page.locator('button, [role="button"], input[type="submit"], input[type="button"]');
    const count = await candidates.count();
    let best = null;
    for (let i = 0; i < count; i++) {
      const candidate = candidates.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const box = await candidate.boundingBox();
      if (!box || box.width < 120 || box.height < 34) continue;
      const info = await candidate.evaluate(el => {
        const style = getComputedStyle(el);
        return {
          text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('value') || '').trim().replace(/\s+/g, ' ').slice(0, 100),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' || style.pointerEvents === 'none',
          opacity: Number(style.opacity || 1),
          type: (el.getAttribute('type') || '').toLowerCase()
        };
      });
      if (info.disabled || info.opacity < 0.35) continue;
      const absoluteTop = box.y + metrics.scrollY;
      const inputBottom = inputBox.y + metrics.scrollY + inputBox.height;
      if (absoluteTop < inputBottom - 20) continue;
      const absoluteBottom = absoluteTop + box.height;
      const bottomRatio = metrics.documentHeight ? absoluteBottom / metrics.documentHeight : 0;
      const widthRatio = metrics.viewportWidth ? box.width / metrics.viewportWidth : 0;
      let score = Math.min(bottomRatio, 1) * 120 + Math.min(widthRatio, 1) * 45;
      if (info.type === 'submit') score += 25;
      if (info.text.length > 0 && info.text.length <= 40) score += 5;
      if (!best || score > best.score) best = { locator: candidate, text: info.text, score };
    }
    if (best) console.log('Bottom primary form CTA candidate:', best.text || '(no text)');
    return best;
  }

  async function handleGenericFormInput(state) {
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
      const signals = [info.name, info.placeholder, info.autocomplete, info.ariaLabel, info.label].join(' ');
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
          await safeCrawlerClick(submit, 'form submit control');
          if (await waitForAdvancement(beforeSignature)) return { recognized: true, advanced: true };
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
        await safeCrawlerClick(nearbyAction.locator, nearbyAction.text || 'bottom primary CTA');
        if (await waitForAdvancement(beforeSignature)) return { recognized: true, advanced: true };
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

  async function isLikelyBranchTransition(state) {
    if (!state) return false;
    if (state.group.length > 0) return false;
    if (isNativeLanguageQuestion(state.pageText)) return false;
    if (await hasVisibleEditableInput()) return false;
    return true;
  }

  async function restoreQuestionPage(questionUrl, expectedOptions) {
    const expected = expectedOptions.map(x => (x || '').trim().toLowerCase()).filter(Boolean);
    const matchesQuestion = state => {
      if (!state || state.group.length < 2) return false;
      const current = state.group.map(x => (x.text || '').trim().toLowerCase());
      const overlap = expected.filter(text => current.includes(text)).length;
      return overlap >= Math.min(2, expected.length);
    };

    try {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
      await page.waitForTimeout(700);
      await silenceMedia();
      let state = await inspectPage();
      if (matchesQuestion(state)) return state;
    } catch {}

    try {
      await page.goto(questionUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(800);
      await silenceMedia();
      const state = await inspectPage();
      if (matchesQuestion(state)) return state;
    } catch {}

    return null;
  }

  async function chooseBranchOptionAndAdvance(optionText, screenNumber, questionState) {
    let state = await inspectPage();
    const wanted = (optionText || '').trim().toLowerCase();
    let option = state.group.find(x => (x.text || '').trim().toLowerCase() === wanted);
    if (!option) option = state.group.find(x => (x.text || '').trim().toLowerCase().includes(wanted));
    if (!option) return { advanced: false, landingState: null };

    const questionUrl = page.url();
    const before = pageSignature(state);
    await safeCrawlerClick(page.locator(`[data-auto-id="${option.id}"]`), option.text || 'branch answer');
    await page.waitForTimeout(700);
    let after = await inspectPage();

    if (page.url() === questionUrl && after.group.length > 0) {
      const beforeText = normalizeContextText(questionState?.pageText || state.pageText, [optionText]);
      const afterText = normalizeContextText(after.pageText, [optionText]);
      if (afterText && beforeText !== afterText) {
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
        await safeCrawlerClick(page.locator(`[data-auto-id="${after.cta.id}"]`), after.cta.text || 'branch CTA');
        if (await waitForAdvancement(beforeCTA, 12000)) {
          await waitForScreenshotReady();
          return { advanced: true, landingState: await inspectPage() };
        }
      }
      return { advanced: false, landingState: after };
    }

    if (pageSignature(after) !== before) {
      await waitForScreenshotReady();
      return { advanced: true, landingState: await inspectPage() };
    }

    if (after.cta) {
      const beforeCTA = pageSignature(after);
      await safeCrawlerClick(page.locator(`[data-auto-id="${after.cta.id}"]`), after.cta.text || 'branch CTA');
      if (await waitForAdvancement(beforeCTA, 12000)) {
        await waitForScreenshotReady();
        return { advanced: true, landingState: await inspectPage() };
      }
    }

    after = await inspectPage();
    return { advanced: pageSignature(after) !== before, landingState: after };
  }

  async function exploreAnswerBranches(state, screenNumber) {
    const instruction = getSelectionInstruction(state.pageText);
    if (isNativeLanguageQuestion(state.pageText)) return false;
    if (isSpeechInputScreen(state.pageText) || hasSkipEscapeChoice(state)) {
      console.log('Skip/optional-input screen detected. Bypassing branch exploration so the escape action can be used.');
      return false;
    }
    if (state.group.length < 2 || state.group.length > 10) return false;
    if (instruction.minSelections !== 1 || instruction.maxSelections !== 1) return false;

    const optionTexts = state.group.map(x => (x.text || '').trim()).filter(Boolean);
    if (optionTexts.length < 2) return false;

    const questionUrl = page.url();
    const questionState = state;
    console.log('Checking whether this single-select question has answer-dependent transition pages.');

    let firstResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
    if (!firstResult.advanced || !firstResult.landingState) {
      await restoreQuestionPage(questionUrl, optionTexts);
      return false;
    }

    let landingState = firstResult.landingState;
    const looksLikeTransition = await isLikelyBranchTransition(landingState);
    if (!looksLikeTransition) {
      console.log('Next screen looks like a normal interactive question/form, so branch exploration is not needed here.');
      await restoreQuestionPage(questionUrl, optionTexts);
      return false;
    }

    console.log(`Answer-dependent transition candidate found. Exploring ${optionTexts.length} answer branches.`);

    for (let i = 0; i < optionTexts.length; i++) {
      if (i > 0) {
        const restored = await restoreQuestionPage(questionUrl, optionTexts);
        if (!restored) {
          console.log('Could not safely return to the branch question. Ending branch exploration.');
          break;
        }
        const result = await chooseBranchOptionAndAdvance(optionTexts[i], screenNumber, questionState);
        if (!result.advanced || !result.landingState) {
          console.log('Could not advance branch for option:', optionTexts[i]);
          continue;
        }
        landingState = result.landingState;
      }

      if (!(await isLikelyBranchTransition(landingState))) {
        console.log('Branch did not lead to a transition-type page:', optionTexts[i]);
        continue;
      }

      await waitForScreenshotReady({ minimumWaitMs: 2400, maxWaitMs: 6000 });
      landingState = await inspectPage();
      const transitionFingerprint = normalizeContextText(landingState.pageText, optionTexts);
      if (supplementalFingerprintSeen(screenNumber, transitionFingerprint, 0.97)) {
        console.log(`Transition for "${optionTexts[i]}" has the same meaningful text as a transition already captured. Skipping duplicate screenshot.`);
        continue;
      }
      const branchName = nextSupplementalFilename(screenNumber);
      await page.screenshot({ path: branchName, fullPage: true });
      console.log(`Captured unique branch transition for "${optionTexts[i]}": ${branchName}`);
    }

    const restored = await restoreQuestionPage(questionUrl, optionTexts);
    if (!restored) {
      console.log('Branch pages were captured, but the crawler could not safely restore the main question.');
      return false;
    }

    console.log('Branch exploration complete. Continuing main funnel through the first answer.');
    const finalResult = await chooseBranchOptionAndAdvance(optionTexts[0], screenNumber, questionState);
    return finalResult.advanced;
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
    if (state.group.length > 0) return await handleAnswerGroup(state, screenNumber);
    const formResult = await handleGenericFormInput(state);
    if (formResult.recognized) return formResult.advanced;
    if (state.cta) {
      console.log('Primary CTA detected:', state.cta.text || '(no text)');
      const beforeSignature = pageSignature(state);
      await safeCrawlerClick(page.locator(`[data-auto-id="${state.cta.id}"]`), state.cta.text || 'primary CTA');
      await page.waitForTimeout(900);
      return pageSignature(await inspectPage()) !== beforeSignature;
    }
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
    const state = await inspectPage();
    const paywallState = await inspectPaywallState();
    const filename = `${String(screenNumber).padStart(2, '0')}.png`;
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`\nCaptured ${filename}`);
    console.log({
      url: page.url(),
      CTA: state.cta?.text || null,
      answerOptions: state.group.map(x => x.text)
    });

    if (paywallState.isPagePaywall) {
      console.log('Paywall detected from discounted price structure.');
      console.log('Crossed prices:', paywallState.crossedPrices);
      console.log('Current prices:', paywallState.currentPrices);
      console.log(`Captured paywall as full-page PNG: ${filename}`);
      console.log('Stopping after paywall capture to avoid payment-loop screenshots.');
      break;
    }

    const beforeSignature = pageSignature(state);
    let acted = false;
    if (state.group.length >= 2 && !isSpeechInputScreen(state.pageText) && !hasSkipEscapeChoice(state)) {
      acted = await exploreAnswerBranches(state, screenNumber);
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
    if (screenNumber === MAX_SCREENS) console.log(`Reached safety cap of ${MAX_SCREENS} screens.`);
  }

  await browser.close();
  console.log('Crawler finished.');
})();

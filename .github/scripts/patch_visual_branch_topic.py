from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

if "const crypto = require('crypto');" not in s:
    s = s.replace("const path = require('path');\n", "const path = require('path');\nconst crypto = require('crypto');\n", 1)

s = s.replace("  const OUTPUT_DIR = createRunOutputDirectory(url);\n", "  let OUTPUT_DIR = createRunOutputDirectory(url);\n", 1)

startup = "  const browser = await chromium.launch();\n  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });\n  await page.goto(url, { waitUntil: 'networkidle' });\n"
if 'async function inferFunnelTopicFromFirstPage()' not in s:
    if startup not in s:
        raise SystemExit('browser startup marker missing')
    helpers = r'''

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
    await page.waitForTimeout(500);
    const buffer = await screenshotBufferNavigationSafe('same-page visual state screenshot');
    const hash = hashScreenshot(buffer);
    const key = String(screenNumber);
    const seen = samePageVariantHashes.get(key) || new Set();
    if (seen.has(hash)) return null;
    const filename = nextFreeLetteredFilename(screenNumber);
    if (!filename) return null;
    fs.writeFileSync(filename, buffer);
    seen.add(hash);
    samePageVariantHashes.set(key, seen);
    console.log(`Captured ${path.basename(filename)} because the page changed visually without advancing${reason ? `: ${reason}` : '.'}`);
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
'''
    s = s.replace(startup, startup + helpers, 1)

old = """      const afterSelection = await inspectPageNavigationSafe('multi-select post-selection inspection');\n      const originalPrompt = questionPromptFingerprint(questionState);\n      const currentPrompt = questionPromptFingerprint(afterSelection);\n      const samePrompt = !!originalPrompt && !!currentPrompt && contextSimilarity(originalPrompt, currentPrompt) >= 0.86;\n      if (sanitizeUrl(page.url()) !== questionUrl || (!samePrompt && pageSignature(afterSelection) !== before)) {\n"""
if 'captureSamePageVisualVariant(screenNumber, `selection: ${selected.join' not in s:
    new = """      const afterSelection = await inspectPageNavigationSafe('multi-select post-selection inspection');\n      const originalPrompt = questionPromptFingerprint(questionState);\n      const currentPrompt = questionPromptFingerprint(afterSelection);\n      const samePrompt = !!originalPrompt && !!currentPrompt && contextSimilarity(originalPrompt, currentPrompt) >= 0.86;\n      if (sanitizeUrl(page.url()) === questionUrl && samePrompt) {\n        await captureSamePageVisualVariant(screenNumber, `selection: ${selected.join(' + ')}`);\n      }\n      if (sanitizeUrl(page.url()) !== questionUrl || (!samePrompt && pageSignature(afterSelection) !== before)) {\n"""
    if old not in s: raise SystemExit('multi-select post selection marker missing')
    s = s.replace(old, new, 1)

old = """      outcomes.push({ answers: testSets[setIndex], fingerprint, screenshotBuffer, landingState });\n      console.log(`Recorded multi-select next-page outcome for: ${testSets[setIndex].join(' + ')}`);\n"""
if 'Contextual branch evidence:' not in s:
    new = """      const affinity = answerOutcomeAffinity(testSets[setIndex], landingState.pageText);\n      outcomes.push({ answers: testSets[setIndex], fingerprint, screenshotBuffer, landingState, affinity });\n      console.log(`Recorded multi-select next-page outcome for: ${testSets[setIndex].join(' + ')}`);\n      if (affinity.connected) {\n        console.log(`Contextual branch evidence: the landing page echoes the selected answer(s): ${affinity.hits.map(hit => `${hit.answer} -> ${hit.matched.join(', ')}`).join(' | ')}. Treating this as a likely answer-dependent transition and verifying the other choices.`);\n      }\n"""
    if old not in s: raise SystemExit('multi-select outcome marker missing')
    s = s.replace(old, new, 1)

old = """      const promptStillMatches = !!originalPrompt && !!currentPrompt && contextSimilarity(originalPrompt, currentPrompt) >= 0.86;\n"""
if 'samePageSelectionState && promptStillMatches' not in s:
    new = """      const promptStillMatches = !!originalPrompt && !!currentPrompt && contextSimilarity(originalPrompt, currentPrompt) >= 0.86;\n      if (samePageSelectionState && promptStillMatches) {\n        await captureSamePageVisualVariant(screenNumber, `selection: ${option.text || '[no visible text]'}`);\n      }\n"""
    if old not in s: raise SystemExit('normal answer visual marker missing')
    s = s.replace(old, new, 1)

old = """    const paywallState = await inspectPaywallState();\n    const filename = path.join(OUTPUT_DIR, `${String(screenNumber).padStart(2, '0')}.png`);\n    await page.screenshot({ path: filename, fullPage: true });\n"""
if 'registerBaseScreenshot(screenNumber, filename);' not in s:
    new = """    const paywallState = await inspectPaywallState();\n    const filename = path.join(OUTPUT_DIR, `${String(screenNumber).padStart(2, '0')}.png`);\n    await prepareFullPageCapture();\n    await page.screenshot({ path: filename, fullPage: true });\n    registerBaseScreenshot(screenNumber, filename);\n"""
    if old not in s: raise SystemExit('main screenshot marker missing')
    s = s.replace(old, new, 1)

# Make multi-select branch filenames collision-safe if visual variants already used letters.
old = """        const filename = path.join(OUTPUT_DIR, `${String(screenNumber).padStart(2, '0')}${branchLetter(i)}.png`);\n        fs.writeFileSync(filename, uniqueOutcomes[i].screenshotBuffer);\n"""
if old in s:
    s = s.replace(old, """        const filename = nextFreeLetteredFilename(screenNumber);\n        if (!filename) continue;\n        fs.writeFileSync(filename, uniqueOutcomes[i].screenshotBuffer);\n""", 1)

p.write_text(s)

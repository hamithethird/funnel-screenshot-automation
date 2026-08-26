from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

anchor = '''  async function handleProfileNumericInput(state, screenNumber = null) {'''
helper = r'''  async function getVisibleFormIntentText() {
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

  async function handleProfileNumericInput(state, screenNumber = null) {'''
if anchor not in s:
    raise SystemExit('profile handler anchor not found')
s = s.replace(anchor, helper, 1)

old = r'''    const pageText = (state?.pageText || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!pageText) return { recognized: false, advanced: false };

    let profileType = null;
    if (/\b(goal|target|desired)\s+weight\b|what(?:'s| is) your goal weight|goal weight/i.test(pageText)) {
      profileType = 'goal-weight';
    } else if (/\b(current\s+weight|your\s+current\s+weight|what(?:'s| is) your current weight|your weight)\b/i.test(pageText)) {
      profileType = 'current-weight';
    } else if (/\b(how tall are you|your height|height)\b/i.test(pageText)) {
      profileType = 'height';
    } else if (/\b(how old are you|your age|age)\b/i.test(pageText)) {
      profileType = 'age';
    }
    if (!profileType) return { recognized: false, advanced: false };
'''
new = r'''    const pageText = (state?.pageText || '').toLowerCase().replace(/\s+/g, ' ').trim();
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
'''
if old not in s:
    raise SystemExit('profile classification block not found')
s = s.replace(old, new, 1)

old2 = '''  async function handleGenericFormInput(state) {
    const fields = page.locator('''
new2 = '''  async function handleGenericFormInput(state) {
    const visibleFormIntent = (await getVisibleFormIntentText()).toLowerCase().replace(/\\s+/g, ' ').trim();
    const fields = page.locator('''
if old2 not in s:
    raise SystemExit('generic form handler anchor not found')
s = s.replace(old2, new2, 1)

old3 = '''      const signals = [info.name, info.placeholder, info.autocomplete, info.ariaLabel, info.label].join(' ');'''
new3 = '''      const signals = [info.name, info.placeholder, info.autocomplete, info.ariaLabel, info.label, visibleFormIntent].join(' ');'''
if old3 not in s:
    raise SystemExit('generic signals anchor not found')
s = s.replace(old3, new3, 1)

p.write_text(s)

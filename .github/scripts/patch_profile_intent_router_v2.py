from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

old = r'''  async function getVisibleFormIntentText() {
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
'''
new = r'''  async function getVisibleFormIntentText() {
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
'''
if old not in s:
    raise SystemExit('getVisibleFormIntentText block not found')
s = s.replace(old, new, 1)

old = r'''    // SPA funnels can keep stale prior-step text in the DOM. Numeric profile
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
new = r'''    // Route the page from what is visibly being asked, before relying on the
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
'''
if old not in s:
    raise SystemExit('profile classification block not found')
s = s.replace(old, new, 1)

old = r'''  async function handleGenericFormInput(state) {
    const visibleFormIntent = (await getVisibleFormIntentText()).toLowerCase().replace(/\s+/g, ' ').trim();

    // Name pages follow the same semantic-first rule as height/weight/age. If the
    // heading says this is a name task, locate the corresponding writable control
    // even when it is custom/contenteditable/hidden rather than a normal text input.
    if (/\bwhat(?:'s| is) your name\b|\benter (?:your )?name\b|\byour name\b/i.test(visibleFormIntent)) {
'''
new = r'''  async function handleGenericFormInput(state) {
    const visibleFormIntent = (await getVisibleFormIntentText()).toLowerCase().replace(/\s+/g, ' ').trim();
    const explicitProfileIntent = await detectExplicitProfileIntent();

    // Name is also routed from the visible task, not from input metadata alone.
    if (explicitProfileIntent?.type === 'name' || /\bwhat(?:'s| is) your name\b|\benter (?:your )?name\b|\byour name\b/i.test(visibleFormIntent)) {
      if (explicitProfileIntent?.type === 'name') console.log('Explicit profile page intent detected: name.');
'''
if old not in s:
    raise SystemExit('generic name block not found')
s = s.replace(old, new, 1)

old = r'''    const initialEditableInput = await hasVisibleEditableInput();
    const passiveTransition = !initialEditableInput && isPassiveTransitionScreen(initialState.pageText);
'''
new = r'''    const initialEditableInput = await hasVisibleEditableInput();
    const initialProfileIntent = await detectExplicitProfileIntent();
    const passiveTransition = !initialEditableInput && !initialProfileIntent && isPassiveTransitionScreen(initialState.pageText);
'''
if old not in s:
    raise SystemExit('wait initial block not found')
s = s.replace(old, new, 1)

old = r'''      const visibleEditableInput = await hasVisibleEditableInput();
      const actionable = visibleEditableInput || state.group.length > 0 || state.cta !== null || isNativeLanguageQuestion(state.pageText) || isSpeechInputScreen(state.pageText) || hasSkipEscapeChoice(state);

      if (actionable) {
        if (passiveTransition) console.log(visibleEditableInput ? 'Passive transition completed: editable form input appeared.' : 'Passive transition completed: actionable screen appeared.');
        return { state, changed: signature !== initialSignature || visibleEditableInput };
      }
'''
new = r'''      const visibleEditableInput = await hasVisibleEditableInput();
      const explicitProfileIntent = await detectExplicitProfileIntent();
      const actionable = !!explicitProfileIntent || visibleEditableInput || state.group.length > 0 || state.cta !== null || isNativeLanguageQuestion(state.pageText) || isSpeechInputScreen(state.pageText) || hasSkipEscapeChoice(state);

      if (actionable) {
        if (explicitProfileIntent) console.log(`Actionable profile page detected from visible context: ${explicitProfileIntent.type}.`);
        if (passiveTransition) console.log(visibleEditableInput ? 'Passive transition completed: editable form input appeared.' : 'Passive transition completed: actionable screen appeared.');
        return { state, changed: signature !== initialSignature || visibleEditableInput || !!explicitProfileIntent };
      }
'''
if old not in s:
    raise SystemExit('wait actionable block not found')
s = s.replace(old, new, 1)

p.write_text(s)

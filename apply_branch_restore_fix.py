from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

old = r'''  async function restoreQuestionPage(questionUrl, expectedOptions, expectedQuestionFingerprint = '') {
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

    try {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
      await page.waitForTimeout(700);
      await silenceMedia();
      const state = await inspectPage();
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
'''

new = r'''  async function restoreQuestionPage(questionUrl, expectedOptions, expectedQuestionFingerprint = '') {
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
      const state = await inspectPage();
      return matchesQuestion(state) ? state : null;
    };

    // If we are already back on the question, do nothing. This is important for
    // branch probing because the first answer must always use the untouched page.
    const currentState = await inspectPage().catch(() => null);
    if (matchesQuestion(currentState)) return currentState;

    // Prefer the funnel's own visible Back control. Many onboarding SPAs keep every
    // step on one URL and manage state internally, so browser history is not a
    // reliable way to return from a transition screen to its source question.
    try {
      const backCandidate = await page.evaluate(() => {
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
          const matched = await inspectAndMatch(900);
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
'''

if old not in s:
    raise SystemExit('restoreQuestionPage block not found')
s = s.replace(old, new, 1)
p.write_text(s)

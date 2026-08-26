from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

anchor = '''  async function handlePassiveEvaluationGate(state) {'''
helper = r'''  async function handleExplicitAgeSelection(state) {
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

  async function handlePassiveEvaluationGate(state) {'''
if anchor not in s:
    raise SystemExit('passive evaluation anchor not found')
s = s.replace(anchor, helper, 1)

old = '''    const scratchResult = await handleScratchReveal(screenNumber, state);
    if (scratchResult.handled) return scratchResult.advanced;

    // Semantic profile-number forms (height/weight/goal weight/age) need
'''
new = '''    const scratchResult = await handleScratchReveal(screenNumber, state);
    if (scratchResult.handled) return scratchResult.advanced;

    // Explicit title/subtitle intent outranks generic answer-card logic. For age
    // selection pages, choose the range containing age 25 instead of branch-probing.
    const ageChoiceResult = await handleExplicitAgeSelection(state);
    if (ageChoiceResult.handled) return ageChoiceResult.advanced;

    // Semantic profile-number forms (height/weight/goal weight/age) need
'''
if old not in s:
    raise SystemExit('advanceOneScreen scratch/profile anchor not found')
s = s.replace(old, new, 1)

old2 = '''    // Evaluation/loading screens can contain a small answer gate (for example
    // Yes/No reminders) that merely resumes the ongoing calculation. Never run
    // branch exploration on those controls.
    const passiveGate = await handlePassiveEvaluationGate(state);
    if (passiveGate.handled) {
      acted = passiveGate.advanced;
    } else if (state.group.length >= 2 && !isSpeechInputScreen(state.pageText) && !hasSkipEscapeChoice(state)) {
'''
new2 = '''    // Read explicit page intent before generic branch exploration. A page whose
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
'''
if old2 not in s:
    raise SystemExit('main loop branch block anchor not found')
s = s.replace(old2, new2, 1)

# Remove the old else-if tail duplicated by the replacement.
dup = '''      acted = await exploreAnswerBranches(state, screenNumber);
    } else if (state.group.length >= 2 && isSpeechInputScreen(state.pageText)) {
      console.log('Branch exploration skipped because this page genuinely requests spoken/audio input.');
    }
'''
# The original tail should now occur immediately after our replacement once.
idx = s.find(new2)
if idx == -1:
    raise SystemExit('replacement verification failed')
post = idx + len(new2)
if s[post:post+len(dup)] == dup:
    s = s[:post] + s[post+len(dup):]

p.write_text(s)

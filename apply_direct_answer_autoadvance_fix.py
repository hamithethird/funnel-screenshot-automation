from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

anchor = '''  async function handleAnswerGroup(state, screenNumber = null) {'''
helper = r'''  function uniqueAnswerOptions(group) {
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

  async function handleAnswerGroup(state, screenNumber = null) {'''
if anchor not in s:
    raise SystemExit('handleAnswerGroup anchor not found')
s = s.replace(anchor, helper, 1)

old1 = '''    const availableAtStart = Math.max(state.group.length, 1);'''
new1 = '''    const initialUniqueGroup = uniqueAnswerOptions(state.group);
    const availableAtStart = Math.max(initialUniqueGroup.length, 1);'''
if old1 not in s:
    raise SystemExit('availableAtStart anchor not found')
s = s.replace(old1, new1, 1)

old2 = '''      let option = null;
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
'''
new2 = '''      const uniqueGroup = uniqueAnswerOptions(state.group);
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
'''
if old2 not in s:
    raise SystemExit('option selection block not found')
s = s.replace(old2, new2, 1)

old3 = '''      const afterSelection = await inspectPage();
      const samePageSelectionState = sanitizeUrl(page.url()) === initialUrl && afterSelection.group.length > 0;
      const contextChanged = normalizeContextText(afterSelection.pageText) !== normalizeContextText(initialState.pageText);
'''
new3 = '''      let afterSelection = await inspectPageNavigationSafe('answer selection inspection');
      const samePageSelectionState = sanitizeUrl(page.url()) === initialUrl && afterSelection.group.length > 0;
      const contextChanged = normalizeContextText(afterSelection.pageText) !== normalizeContextText(initialState.pageText);
'''
if old3 not in s:
    raise SystemExit('afterSelection block not found')
s = s.replace(old3, new3, 1)

old4 = '''      if (pageSignature(afterSelection) !== initialSignature && !afterSelection.group.length) return true;

      if (selectedKeys.size < minSelections) {'''
new4 = r'''      // A single-select page without an explicit Continue button commonly uses
      // the answer card itself as navigation. If clicking the answer moved us to a
      // genuinely different question/page, stop immediately instead of selecting a
      // second answer from the next screen.
      const afterSignature = pageSignature(afterSelection);
      const promptChanged = !!originalPrompt && !!currentPrompt && !promptStillMatches;
      const answerSetChanged = !sameAnswerSet;
      if (afterSignature !== initialSignature && (promptChanged || answerSetChanged || !afterSelection.group.length)) {
        return true;
      }

      if (selectedKeys.size < minSelections) {'''
if old4 not in s:
    raise SystemExit('page change block not found')
s = s.replace(old4, new4, 1)

old5 = '''      if (afterSelection.cta) {
        console.log('Minimum selection requirement satisfied. Using CTA:', afterSelection.cta.text || '(no text)');
        const beforeCTA = pageSignature(afterSelection);
        const ctaClicked = await safeCrawlerClick(
          page.locator(`[data-auto-id="${afterSelection.cta.id}"]`),
          afterSelection.cta.text || 'answer-group CTA'
        );
        if (ctaClicked && await waitForAdvancement(beforeCTA, 10000)) return true;
      }

      if (instruction.maxSelections && selectedKeys.size >= instruction.maxSelections) break;
'''
new5 = r'''      if (afterSelection.cta) {
        console.log('Minimum selection requirement satisfied. Using CTA:', afterSelection.cta.text || '(no text)');
        const beforeCTA = pageSignature(afterSelection);
        const ctaClicked = await safeCrawlerClick(
          page.locator(`[data-auto-id="${afterSelection.cta.id}"]`),
          afterSelection.cta.text || 'answer-group CTA'
        );
        if (ctaClicked && await waitForAdvancement(beforeCTA, 10000)) return true;
      } else if (minSelections === 1 && !instruction.maxSelections) {
        // No explicit navigation CTA: this is usually an auto-advance answer card.
        // Do not start selecting other answers. Retry the larger containing card
        // once, then stop safely if the funnel still does not move.
        const advancedByCard = await clickAnswerCardFallback(option.text || '', initialSignature);
        if (advancedByCard) return true;
        console.log('Single-select page has no explicit Continue CTA and the selected answer did not advance. Not selecting additional answers.');
        return false;
      }

      if (instruction.maxSelections && selectedKeys.size >= instruction.maxSelections) break;
'''
if old5 not in s:
    raise SystemExit('cta block not found')
s = s.replace(old5, new5, 1)

p.write_text(s)

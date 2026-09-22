from pathlib import Path

p = Path("funnel-crawler-multiscreen.js")
s = p.read_text()

anchor = "  async function exploreAnswerBranches(state, screenNumber) {"

helper = r'''  async function inspectIsolatedBranchPage(probePage) {
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

'''

if "async function exploreAnswerBranchesIsolated" not in s:
    if anchor not in s:
        raise SystemExit("Could not find branch insertion anchor.")
    s = s.replace(anchor, helper + anchor, 1)

old_flag = """  // SAFETY: the primary crawl is forward-only. Branch probing used to mutate
  // the live SPA session, then call Back/goBack/page.goto to restore earlier
  // questions. On stateful funnels that can reset progress to page 1 and can also
  // consume/skips screens before the numbered capture loop sees them. Keep branch
  // discovery disabled on the live page until it runs in an isolated checkpointed
  // context. Same-page selection/popup capture still works through handleAnswerGroup.
  const LIVE_BRANCH_PROBING_ENABLED = false;
"""
new_flag = """  // SAFETY: the primary page remains forward-only. Conditional-answer testing
  // happens only in disposable browser contexts cloned from the current checkpoint.
  const ISOLATED_BRANCH_PROBING_ENABLED = true;
"""
if old_flag in s:
    s = s.replace(old_flag, new_flag, 1)
elif "const ISOLATED_BRANCH_PROBING_ENABLED = true;" not in s:
    raise SystemExit("Could not find branch safety flag.")

old_loop = """      } else if (LIVE_BRANCH_PROBING_ENABLED && state.group.length >= 2 && !isSpeechInputScreen(state.pageText) && !hasSkipEscapeChoice(state)) {
        acted = await exploreAnswerBranches(state, screenNumber);
      } else if (!LIVE_BRANCH_PROBING_ENABLED && state.group.length >= 2 && !isSpeechInputScreen(state.pageText) && !hasSkipEscapeChoice(state)) {
        console.log('Forward-only safety mode: skipping destructive branch probing on the live funnel session. Taking the normal answer path instead.');
      } else if (state.group.length >= 2 && isSpeechInputScreen(state.pageText)) {
"""
new_loop = """      } else if (ISOLATED_BRANCH_PROBING_ENABLED && state.group.length >= 2 && !isSpeechInputScreen(state.pageText) && !hasSkipEscapeChoice(state)) {
        // Probe alternates without mutating the live page. Keep acted=false so the
        // untouched primary page then advances once on its normal path.
        await exploreAnswerBranchesIsolated(state, screenNumber);
      } else if (state.group.length >= 2 && isSpeechInputScreen(state.pageText)) {
"""
if old_loop in s:
    s = s.replace(old_loop, new_loop, 1)
elif "await exploreAnswerBranchesIsolated(state, screenNumber);" not in s:
    raise SystemExit("Could not find main-loop branch gate.")

p.write_text(s)
print("Patched isolated forward-only branch probing.")

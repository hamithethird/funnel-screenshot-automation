from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

old = '''  async function handleRequiredAgreementCheckboxes(input) {
    const legalPattern = /\\b(terms?|conditions?|privacy|policy|legal|agreement)\\b/i;
    const acceptancePattern = /\\b(accept|agree|consent)\\b/i;
    const marketingPattern = /\\b(news|newsletter|updates?|offers?|promotions?|marketing|communications?)\\b/i;
'''
new = '''  async function handleRequiredAgreementCheckboxes(input) {
    const legalPattern = /\\b(terms?|conditions?|privacy|policy|legal|agreement|processing|data processing)\\b/i;
    const acceptancePattern = /\\b(accept|agree|consent|required|must)\\b/i;
    const marketingPattern = /\\b(news|newsletter|updates?|offers?|promotions?|marketing|communications?|products?\\s*&?\\s*services?|special offers?)\\b/i;
'''
if old not in s:
    raise SystemExit('agreement header marker missing')
s = s.replace(old, new, 1)

old = '''      const isLegalAgreement = legalPattern.test(info.text) && (acceptancePattern.test(info.text) || info.required);
      const isMarketingOnly = marketingPattern.test(info.text) && !legalPattern.test(info.text);
      if (!isLegalAgreement || isMarketingOnly) continue;
      legalFound = true;
'''
new = '''      const isMarketing = marketingPattern.test(info.text);
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
'''
if old not in s:
    raise SystemExit('agreement classification marker missing')
s = s.replace(old, new, 1)

old = '''      const nearbyAction = await findBottomPrimaryFormAction(input);
      if (nearbyAction) {
        const termsBeforeNearbyAction = await handleRequiredAgreementCheckboxes(input);
        if (!termsBeforeNearbyAction.active) return { recognized: true, advanced: false };
        const clicked = await safeCrawlerClick(nearbyAction.locator, nearbyAction.text || 'bottom primary CTA');
        if (clicked && await waitForAdvancement(beforeSignature)) return { recognized: true, advanced: true };
        if (fieldType === 'email' && await retryWithNextEmailIfNeeded(input)) {
          return await handleGenericFormInput(await inspectPageNavigationSafe('email collision retry'));
        }
      }
'''
new = '''      const nearbyAction = await findBottomPrimaryFormAction(input);
      if (nearbyAction) {
        const termsBeforeNearbyAction = await handleRequiredAgreementCheckboxes(input);
        if (!termsBeforeNearbyAction.active) return { recognized: true, advanced: false };
        const clicked = await safeCrawlerClick(nearbyAction.locator, nearbyAction.text || 'bottom primary CTA');
        if (clicked && await waitForAdvancement(beforeSignature)) return { recognized: true, advanced: true };
        if (fieldType === 'email' && await retryWithNextEmailIfNeeded(input)) {
          return await handleGenericFormInput(await inspectPageNavigationSafe('email collision retry'));
        }
      }

      // Some email-gate pages use a branded action such as GET MY PLAN / SEND MY PLAN
      // instead of a generic Continue button and place it outside the input's form.
      // Treat these as explicit email submission CTAs after the field is valid and
      // optional marketing consent has been kept off.
      if (fieldType === 'email') {
        const planAction = page.getByRole('button', { name: /^(get|send|show|unlock|email)\\s+(me\\s+)?(my\\s+)?plan!?$/i }).first();
        const planLink = page.getByRole('link', { name: /^(get|send|show|unlock|email)\\s+(me\\s+)?(my\\s+)?plan!?$/i }).first();
        let planTarget = null;
        if ((await planAction.count()) > 0 && await planAction.isVisible().catch(() => false) && await planAction.isEnabled().catch(() => false)) planTarget = planAction;
        else if ((await planLink.count()) > 0 && await planLink.isVisible().catch(() => false)) planTarget = planLink;
        if (planTarget) {
          console.log('Email-plan submission CTA detected.');
          const agreementBeforePlan = await handleRequiredAgreementCheckboxes(input);
          if (!agreementBeforePlan.active) return { recognized: true, advanced: false };
          const clicked = await safeCrawlerClick(planTarget, 'email plan submission CTA');
          if (clicked && await waitForAdvancement(beforeSignature, 12000)) return { recognized: true, advanced: true };
          if (await retryWithNextEmailIfNeeded(input)) {
            return await handleGenericFormInput(await inspectPageNavigationSafe('email collision retry'));
          }
        }
      }
'''
if old not in s:
    raise SystemExit('generic form nearby action marker missing')
s = s.replace(old, new, 1)

p.write_text(s)

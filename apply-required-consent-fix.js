const fs = require('fs');

const path = 'funnel-crawler-multiscreen.js';
let source = fs.readFileSync(path, 'utf8');

if (source.includes('async function handleRequiredAgreementCheckboxes')) {
  console.log('Required-consent fix is already applied.');
  process.exit(0);
}

const helperMarker = '  async function handleGenericFormInput(state) {';
const helper = `  async function handleRequiredAgreementCheckboxes(input) {
    const agreementPattern = /\\b(accept|agree|consent|terms?|conditions?|privacy|policy)\\b/i;
    const candidates = page.locator(
      'input[type="checkbox"], [role="checkbox"]'
    );

    const count = await candidates.count();
    let handled = false;

    for (let i = 0; i < count; i++) {
      const checkbox = candidates.nth(i);

      if (!(await checkbox.isVisible())) {
        continue;
      }

      const info = await checkbox.evaluate(el => {
        let labelText = '';

        if (el.id) {
          const label = document.querySelector(
            \`label[for="\${CSS.escape(el.id)}"]\`
          );
          if (label) {
            labelText = label.innerText || label.textContent || '';
          }
        }

        if (!labelText) {
          const parentLabel = el.closest('label');
          if (parentLabel) {
            labelText = parentLabel.innerText || parentLabel.textContent || '';
          }
        }

        if (!labelText) {
          const container = el.closest('div, section, fieldset');
          if (container) {
            labelText = container.innerText || container.textContent || '';
          }
        }

        return {
          text: (labelText || el.getAttribute('aria-label') || '')
            .trim()
            .replace(/\\s+/g, ' ')
            .slice(0, 300),
          checked:
            el.checked === true ||
            el.getAttribute('aria-checked') === 'true'
        };
      });

      if (!agreementPattern.test(info.text) || info.checked) {
        continue;
      }

      console.log('Required agreement checkbox detected:', info.text);

      try {
        await checkbox.check({ force: false });
      } catch {
        await checkbox.click();
      }

      await page.waitForTimeout(350);
      handled = true;
    }

    if (handled) {
      // Give reactive forms time to enable their Continue/Submit button.
      await input.evaluate(el => el.blur());
      await page.waitForTimeout(500);
    }

    return handled;
  }

`;

if (!source.includes(helperMarker)) {
  throw new Error('Could not find form-handler insertion point.');
}
source = source.replace(helperMarker, helper + helperMarker);

const fillMarker = `      await page.waitForTimeout(500);\n\n      const beforeSubmitState = await inspectPage();`;
const fillReplacement = `      await page.waitForTimeout(500);\n\n      // Some onboarding forms require a terms/privacy agreement checkbox\n      // before their Continue/Submit control becomes enabled. Handle only\n      // visible checkbox controls whose local label clearly signals consent.\n      await handleRequiredAgreementCheckboxes(input);\n\n      const beforeSubmitState = await inspectPage();`;

if (!source.includes(fillMarker)) {
  throw new Error('Could not find post-fill insertion point.');
}
source = source.replace(fillMarker, fillReplacement);

fs.writeFileSync(path, source);
console.log('Applied required consent checkbox handling to funnel-crawler-multiscreen.js');

const fs = require('fs');
const path = 'funnel-crawler-multiscreen.js';
let s = fs.readFileSync(path, 'utf8');

s = s.replace(
`      if (centerY > vh * 0.65) {
        score += 40;
      } else if (centerY > vh * 0.5) {
        score += 20;
      }`,
`      if (centerY > vh * 0.82) {
        score += 90;
      } else if (centerY > vh * 0.68) {
        score += 65;
      } else if (centerY > vh * 0.5) {
        score += 25;
      } else {
        score -= 15;
      }`
);

const startMarker = '  async function findSafeFormActionNearInput(input) {';
const consentHelperMarker = '  async function handleRequiredAgreementCheckboxes(input) {';
const genericFormMarker = '  async function handleGenericFormInput(state) {';

if (s.includes(startMarker)) {
  const start = s.indexOf(startMarker);

  // IMPORTANT: required-consent handling may have been inserted between the
  // old form-action helper and handleGenericFormInput. Preserve that helper
  // instead of deleting the whole region up to handleGenericFormInput.
  const endMarker = s.includes(consentHelperMarker)
    ? consentHelperMarker
    : genericFormMarker;

  const end = s.indexOf(endMarker, start);
  if (end < 0) throw new Error('form helper end not found');

  const replacement = `  async function findBottomPrimaryFormAction(input) {
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
      if (!(await candidate.isVisible())) continue;
      const box = await candidate.boundingBox();
      if (!box || box.width < 120 || box.height < 34) continue;

      const info = await candidate.evaluate(el => {
        const style = getComputedStyle(el);
        return {
          text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('value') || '').trim().replace(/\\s+/g, ' ').slice(0, 100),
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

`;

  s = s.slice(0, start) + replacement + s.slice(end);
}

s = s.replace(/findSafeFormActionNearInput\(input\)/g, 'findBottomPrimaryFormAction(input)');
s = s.replace(/using nearby button:/g, 'using bottom primary CTA:');

fs.writeFileSync(path, s);
console.log('Applied bottom-primary CTA prioritization.');

from pathlib import Path
import re

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

pattern = re.compile(r"  async function inspectPaywallState\(\) \{.*?\n  async function inspectPage\(\) \{", re.S)
replacement = r'''  async function inspectPaywallState() {
    return await page.evaluate(() => {
      const normalize = value => (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const bodyText = normalize(document.body.innerText || '');
      const currencyPattern = /(?:[$€£¥₺₹₽₴₩]|\b(?:usd|eur|gbp|cad|aud|nzd|try|jpy|cny|inr|uah|rub|krw)\b)\s*\d|\d[\d.,\s]*\s*(?:[$€£¥₺₹₽₴₩]|\b(?:usd|eur|gbp|cad|aud|nzd|try|jpy|cny|inr|uah|rub|krw)\b)/i;
      const elements = Array.from(document.querySelectorAll('body *'));
      const prices = [];
      for (const el of elements) {
        if (el.children.length > 3) continue;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
          style.visibility !== 'hidden' && Number(style.opacity) > 0;
        if (!visible) continue;
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160);
        if (!text || !currencyPattern.test(text)) continue;
        const crossed = el.tagName.toLowerCase() === 'del' || el.tagName.toLowerCase() === 's' ||
          style.textDecorationLine.includes('line-through') || style.textDecoration.includes('line-through');
        const modalAncestor = el.closest(
          '[role="dialog"], [aria-modal="true"], .modal, [class*="modal"], [class*="popup"], [class*="dialog"]'
        );
        prices.push({ text, crossed, inModal: !!modalAncestor });
      }
      const unique = [];
      const seen = new Set();
      for (const price of prices) {
        const key = `${price.text}|${price.crossed}|${price.inModal}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(price);
        }
      }
      const crossed = unique.filter(x => x.crossed);
      const current = unique.filter(x => !x.crossed);
      const hasDiscountPair = crossed.length > 0 && current.length > 0;
      const pairOnlyInModal = hasDiscountPair && crossed.every(x => x.inModal) && current.every(x => x.inModal);
      const documentHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const documentWidth = Math.max(document.body.scrollWidth, document.documentElement.scrollWidth);
      const longPage = documentHeight > window.innerHeight * 1.3;

      const readyPlanPattern = /\b(?:your|the)\s+(?:personal(?:ized|ised)?\s+)?(?:plan|program|programme|learning plan|improvement plan)\s+(?:is\s+)?(?:ready|complete|prepared|created|built)\b|\b(?:plan|program|programme)\s+(?:is\s+)?ready\b/i;
      const pricingPattern = /\b(?:pricing|price|subscription|subscribe|membership|billing|payment|trial|week(?:ly)?|month(?:ly)?|year(?:ly)?|annual|lifetime|most popular|discount|off|unlock|unlimited access|choose (?:your|a) plan|select (?:your|a) plan)\b/i;
      const purchasePattern = /\b(?:buy|purchase|subscribe|start (?:my |your )?(?:trial|plan)|claim (?:offer|discount)|unlock (?:my |your )?(?:plan|access|results?)|get (?:my |your )?(?:plan|access)|continue to payment)\b/i;
      const hasPlanReadyLanguage = readyPlanPattern.test(bodyText);
      const hasPricingLanguage = pricingPattern.test(bodyText);
      const hasPurchaseLanguage = purchasePattern.test(bodyText);
      const hasMultiplePrices = current.length >= 2;
      const hasPlanPricingPaywall = hasPlanReadyLanguage && hasPricingLanguage && (current.length >= 1 || hasPurchaseLanguage);
      const hasStrongPricingPaywall = hasPricingLanguage && hasMultiplePrices && (hasPurchaseLanguage || longPage);
      const discountPaywall = hasDiscountPair && !pairOnlyInModal && longPage;
      const isPagePaywall = discountPaywall || hasPlanPricingPaywall || hasStrongPricingPaywall;
      let reason = null;
      if (discountPaywall) reason = 'discounted price structure';
      else if (hasPlanPricingPaywall) reason = 'plan-ready + pricing/subscription context';
      else if (hasStrongPricingPaywall) reason = 'strong pricing/subscription structure';

      return {
        hasDiscountPair, pairOnlyInModal, longPage, documentHeight, documentWidth,
        crossedPrices: crossed.map(x => x.text).slice(0, 5),
        currentPrices: current.map(x => x.text).slice(0, 8),
        hasPlanReadyLanguage, hasPricingLanguage, hasPurchaseLanguage,
        isPagePaywall, reason
      };
    });
  }

  async function inspectPage() {'''

s2, n = pattern.subn(lambda m: replacement, s, count=1)
if n != 1:
    raise SystemExit(f'Expected one paywall function replacement, got {n}')

old = """    if (paywallState.isPagePaywall) {\n      console.log('Paywall detected from discounted price structure.');\n      console.log('Crossed prices:', paywallState.crossedPrices);\n      console.log('Current prices:', paywallState.currentPrices);\n      console.log(`Captured paywall as full-page PNG: ${filename}`);\n      console.log('Stopping after paywall capture to avoid payment-loop screenshots.');\n      break;\n    }"""
new = """    if (paywallState.isPagePaywall) {\n      console.log('Paywall detected:', paywallState.reason || 'pricing/paywall evidence');\n      if (paywallState.crossedPrices.length) console.log('Crossed prices:', paywallState.crossedPrices);\n      if (paywallState.currentPrices.length) console.log('Current prices:', paywallState.currentPrices);\n      console.log(`Captured paywall as full-page PNG: ${filename}`);\n      console.log('Stopping immediately after paywall capture; no paywall CTA will be clicked.');\n      break;\n    }"""
if old not in s2:
    raise SystemExit('Could not find paywall stop block')
s2 = s2.replace(old, new, 1)

old_cap = """    if (screenNumber === MAX_SCREENS) console.log(`Reached safety cap of ${MAX_SCREENS} screens.`);\n  }\n\n  await browser.close();"""
new_cap = """    if (screenNumber === MAX_SCREENS) {\n      console.log(`Reached safety cap of ${MAX_SCREENS} screens. Stopping crawler.`);\n      break;\n    }\n  }\n\n  await browser.close();"""
if old_cap not in s2:
    raise SystemExit('Could not find safety-cap block')
s2 = s2.replace(old_cap, new_cap, 1)

p.write_text(s2)

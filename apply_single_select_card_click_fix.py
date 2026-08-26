from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

old = '''      if (afterSelection.cta) {
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
'''
new = '''      if (afterSelection.cta) {
        console.log('Minimum selection requirement satisfied. Using CTA:', afterSelection.cta.text || '(no text)');
        const beforeCTA = pageSignature(afterSelection);
        const ctaClicked = await safeCrawlerClick(
          page.locator(`[data-auto-id="${afterSelection.cta.id}"]`),
          afterSelection.cta.text || 'answer-group CTA'
        );
        if (ctaClicked && await waitForAdvancement(beforeCTA, 10000)) return true;
      } else if (minSelections === 1 && (instruction.maxSelections === null || instruction.maxSelections === 1)) {
        // Single-select pages often use the answer card itself as navigation and
        // therefore have no separate Continue CTA. This applies whether the parser
        // expresses the single-select rule as maxSelections=null or maxSelections=1.
        // Retry the larger containing answer card once before giving up.
        const advancedByCard = await clickAnswerCardFallback(option.text || '', initialSignature);
        if (advancedByCard) return true;
        console.log('Single-select page has no explicit Continue CTA and neither the nested control nor the containing answer card advanced.');
        return false;
      }
'''
if old not in s:
    raise SystemExit('single-select CTA fallback block not found')
s = s.replace(old, new, 1)

p.write_text(s)

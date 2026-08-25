from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()
old = '''      const sameQuestionStillVisible = optionsStillMatch && promptStillMatches;
      if (sameQuestionStillVisible && afterText && beforeText !== afterText) {
        await captureSupplementalState(
          screenNumber,
          after,
          `post-selection response for "${optionText}"`,
          [optionText],
          0.95
        );
      }
      if (after.cta) {
'''
new = '''      const sameQuestionStillVisible = optionsStillMatch && promptStillMatches;

      // A large number of onboarding funnels are SPAs: clicking an answer replaces
      // the current question with the next question without changing the URL. If
      // the prompt/answer set no longer matches the original question, that is real
      // advancement and must be returned as the branch landing state. Previously we
      // fell through and reported advance-failed simply because another answer group
      // was already visible on the same URL.
      if (!sameQuestionStillVisible && pageSignature(after) !== before) {
        await waitForScreenshotReady();
        return {
          advanced: true,
          landingState: await inspectPageNavigationSafe('same-URL next-question branch landing')
        };
      }

      if (sameQuestionStillVisible && afterText && beforeText !== afterText) {
        await captureSupplementalState(
          screenNumber,
          after,
          `post-selection response for "${optionText}"`,
          [optionText],
          0.95
        );
      }
      if (after.cta) {
'''
if old not in s:
    raise SystemExit('same-URL branch block not found')
s = s.replace(old, new, 1)
p.write_text(s)

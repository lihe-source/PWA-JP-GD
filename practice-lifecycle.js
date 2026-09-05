export function isPracticeActive(document, router = {}) {
  if (router.quizActive || router.essayActive || router.handwritingActive) return true;
  if (document.querySelector('#quiz-ghost-input, #kana-reading-answer, .kana-writing-canvas, .reading-quiz-shell, .reading-loading, .ai-loading')) return true;
  return [...document.querySelectorAll('.essay-textarea, .aiask-textarea')]
    .some(input => String(input.value || '').trim());
}

export function canUpdateApp({ document, router, storage, cloudBusy = false }) {
  const status = storage?.getStatus?.();
  return !cloudBusy && !isPracticeActive(document, router) &&
    status?.ready !== false && (!status?.saveState || status.saveState === 'saved');
}

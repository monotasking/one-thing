/* Reusable immediate-feedback questions. No network or learner-data storage. */
document.querySelectorAll('[data-quiz]').forEach(quiz => {
  const feedback = quiz.querySelector('.feedback[data-feedback]');
  quiz.querySelectorAll('button[data-answer]').forEach(button => {
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      quiz.querySelectorAll('button[data-answer]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
      const correct = button.dataset.answer === quiz.dataset.correct;
      feedback.dataset.result = correct ? 'correct' : 'incorrect';
      feedback.textContent = button.dataset.feedback;
    });
  });
});

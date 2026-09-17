/* Reusable, local-only step playback. Panels remain readable without JavaScript. */
document.querySelectorAll('[data-flow-lesson]').forEach(root => {
  const panels = [...root.querySelectorAll('[data-flow-step]')];
  if (!panels.length) return;
  const previous = root.querySelector('[data-flow-prev]');
  const next = root.querySelector('[data-flow-next]');
  const count = root.querySelector('[data-flow-count]');
  let index = 0;
  function show() {
    panels.forEach((panel, i) => { panel.hidden = i !== index; });
    previous.disabled = index === 0;
    next.disabled = index === panels.length - 1;
    count.textContent = `${index + 1} / ${panels.length}`;
    root.querySelectorAll('[data-flow-role]').forEach(role => {
      const active = panels[index].dataset.roles.split(' ').includes(role.dataset.flowRole);
      role.classList.toggle('is-active', active);
    });
  }
  previous.addEventListener('click', () => { index = Math.max(0, index - 1); show(); });
  next.addEventListener('click', () => { index = Math.min(panels.length - 1, index + 1); show(); });
  show();
});

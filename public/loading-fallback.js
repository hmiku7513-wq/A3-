(() => {
  const screen = document.getElementById('loading-screen');
  const skip = document.getElementById('loading-skip');
  if (!screen) return;

  const close = () => {
    screen.classList.add('is-hidden');
    setTimeout(() => { screen.hidden = true; }, 520);
  };

  // The escape hatch is visible from the first frame; this only provides
  // a final hide if the main app never gets a chance to close the veil.
  setTimeout(() => { if (!screen.hidden) close(); }, 12000);
  if (skip) skip.addEventListener('click', close);
})();

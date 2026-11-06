// Copy a terminal block's commands without the "$ " prompts.
document.querySelectorAll('.copy-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var text = document.getElementById(btn.dataset.copy).textContent.replace(/^(\$|PS>) /gm, '');
    navigator.clipboard.writeText(text).then(function () {
      btn.textContent = 'Copied';
      btn.classList.add('done');
      setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1600);
    });
  });
});

// Theme switch: Auto follows the system and stores nothing.
var root = document.documentElement;
var themeButtons = document.querySelectorAll('[data-theme-choice]');
function showChoice(choice) {
  themeButtons.forEach(function (b) {
    b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice));
  });
}
showChoice(root.dataset.theme || 'auto');
themeButtons.forEach(function (btn) {
  btn.addEventListener('click', function () {
    var choice = btn.dataset.themeChoice;
    if (choice === 'auto') delete root.dataset.theme;
    else root.dataset.theme = choice;
    try {
      if (choice === 'auto') localStorage.removeItem('wageroute-theme');
      else localStorage.setItem('wageroute-theme', choice);
    } catch (e) {}
    showChoice(choice);
  });
});

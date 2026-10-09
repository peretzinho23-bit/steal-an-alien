// Runs before the page paints so there is no flash of the wrong theme. Kept as its own file: the CSP forbids inline scripts.
try {
  const saved = localStorage.getItem('saa-theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch {
  /* storage can be blocked; the system preference applies */
}

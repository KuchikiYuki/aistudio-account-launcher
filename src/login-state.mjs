// Runs in the account page; reads visible identity and prompt availability only.
export function inspectStudioLogin() {
  if (location.origin !== 'https://aistudio.google.com' || !location.pathname.includes('prompts')) return { ready: false, email: null };
  const visible = element => {
    try { return element.checkVisibility({ visibilityProperty: true }); }
    catch { return Boolean(element.getClientRects().length); }
  };
  const prompt = [...document.querySelectorAll('ms-prompt-box textarea')].some(visible);
  let email = null;
  const identity = document.querySelectorAll('a[href*="accounts.google.com"],a[href*="myaccount.google.com"],button[aria-label*="Google"],img[alt]');
  for (const element of identity) {
    const label = [element.getAttribute('aria-label'), element.getAttribute('alt'), element.getAttribute('title')].filter(Boolean).join(' ');
    const match = label.match(/[\w.+-]+@[\w.-]+\.\w+/);
    if (match) { email = match[0].toLowerCase(); break; }
  }
  return { ready: prompt, email };
}

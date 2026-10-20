// How a window rendered as its own page closes: a pop-out window the site
// opened closes itself; a page someone navigated to goes back to the home page.
export function closePopoutPage(home: () => void): void {
  if (typeof window !== "undefined" && window.opener) window.close();
  else home();
}

/**
 * The hosted pairing page (AC-032.3). `sib pair` prints `<origin>/pair#t=<token>`. The token sits
 * in the URL fragment, which browsers never send to a server, so access logs and link-preview bots
 * never see it and a preview cannot spend it. `GET /pair` returns this page; its button POSTs the
 * token, and only that request (Origin-checked, rate limited) uses it up.
 *
 * The page works under the app's CSP (`default-src 'self'`): the script and the style are files
 * of their own, with no inline code.
 */

export const PAIR_PAGE_PATHS = {
  page: "/pair",
  script: "/pair.js",
  style: "/pair.css",
} as const;

export const PAIR_PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <meta name="robots" content="noindex" />
    <title>Pair this phone</title>
    <link rel="stylesheet" href="${PAIR_PAGE_PATHS.style}" />
  </head>
  <body>
    <main>
      <h1>Pair this phone</h1>
      <p>This is a private server for one household. Link this phone once and it stays signed in.</p>
      <button id="pair" type="button">Pair this phone</button>
      <p id="status" role="status"></p>
    </main>
    <script src="${PAIR_PAGE_PATHS.script}" defer></script>
  </body>
</html>
`;

/** Reads the token from the fragment, drops it from the address bar, POSTs it on the click. */
export const PAIR_PAGE_SCRIPT = `(function () {
  var button = document.getElementById("pair");
  var status = document.getElementById("status");
  var found = /^#t=([A-Za-z0-9_-]{43})$/.exec(window.location.hash);
  if (found === null) {
    button.disabled = true;
    status.textContent =
      "This page needs the link that \`sib pair\` prints on the server. Open that link.";
    return;
  }
  var token = found[1];
  button.addEventListener("click", function () {
    button.disabled = true;
    status.textContent = "Pairing...";
    fetch("/pair", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: token }),
    })
      .then(function (response) {
        if (response.ok) {
          // The token is spent: drop it from the address bar. After a failure it stays, so the
          // person can try again or reload this page.
          window.history.replaceState(null, "", window.location.pathname);
          window.location.replace("/");
          return;
        }
        status.textContent =
          response.status === 429
            ? "Too many tries. Wait a minute, then open the link again."
            : "This link is invalid, expired or used up. Run \`sib pair\` on the server for a new one.";
        button.disabled = false;
      })
      .catch(function () {
        status.textContent = "Could not reach the server. Try again.";
        button.disabled = false;
      });
  });
})();
`;

export const PAIR_PAGE_STYLE = `body {
  margin: 0;
  font-family: system-ui, sans-serif;
  background: #faf7f0;
  color: #1f1b16;
}
main {
  max-width: 28rem;
  margin: 0 auto;
  padding: 3rem 1rem;
}
button {
  min-height: 48px;
  padding: 0 1.5rem;
  border: 0;
  border-radius: 0.5rem;
  background: #1f1b16;
  color: #faf7f0;
  font: inherit;
  font-weight: 600;
}
button:disabled {
  opacity: 0.6;
}
`;

import { signal, effect, routes } from "./signals";
import { initSession, clearSession, getSession, getToken } from "./session";
import "./components/app-login";
import "./components/app-home";

const app = document.getElementById("app")!;

// --- Session singleton ---

const sessionReady = signal(false);

function bootSession(token: string): void {
  clearSession();
  sessionReady.set(false);
  const session = initSession(token);
  let fired = false;
  effect(() => {
    if (session.profile.get() && !fired) {
      fired = true;
      sessionReady.set(true);
      // Load claude helper when RUNTIME_CLAUDE=true
      if (process.env.RUNTIME_CLAUDE === "true") {
        (window as any).__session = session;
        const s = document.createElement("script");
        s.src = "/claude.js";
        document.head.appendChild(s);
      }
    }
  });
}

function authRoute(mount: () => void): void {
  if (!sessionReady.get()) {
    if (!getToken()) { location.hash = "/"; return; }
    app.innerHTML = `<p>Connecting…</p>`;
    return;
  }
  mount();
}

// Restore session from stored token on reload
const existingToken = getToken();
if (existingToken) bootSession(existingToken);

// --- Routes ---

routes(app, {
  "/": () => {
    const el = document.createElement("app-login");
    app.appendChild(el);
    el.addEventListener("authenticated", ((e: CustomEvent) => {
      bootSession(e.detail.token);
      location.hash = "/home";
    }) as EventListener);
  },
  "/home": () => authRoute(() => {
    const el = document.createElement("app-home");
    app.appendChild(el);
  }),
});

import { signal, effect, routes, when, navigate } from "@blueshed/railroad";
import { initSession, clearSession, getToken } from "./lib/session";
import { AppLogin } from "./components/app-login";
import { AppHome } from "./components/app-home";
import { AppTheme } from "./components/app-theme";

const app = document.getElementById("app")!;

// Mount theme toggle before the router target
document.body.insertBefore(<AppTheme />, app);

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

// Restore session from stored token on reload
const existingToken = getToken();
if (existingToken) bootSession(existingToken);

// --- Routes ---

routes(app, {
  "/": () => (
    <AppLogin onAuthenticated={(token: string) => {
      bootSession(token);
      navigate("/home");
    }} />
  ),
  "/home": () => {
    if (!getToken()) { navigate("/"); return <></>; }
    return when(
      sessionReady,
      () => <AppHome />,
      () => <p>Connecting&#x2026;</p>,
    );
  },
});

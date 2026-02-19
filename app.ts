import { routes } from "./signals";
import { getToken } from "./session";
import "./components/app-login";
import "./components/app-home";

const app = document.getElementById("app")!;

// Restore session from stored token
if (getToken()) location.hash = "/home";

routes(app, {
  "/": () => {
    const el = document.createElement("app-login");
    app.appendChild(el);
    el.addEventListener("authenticated", () => {
      location.hash = "/home";
    });
  },
  "/home": () => {
    const token = getToken();
    if (!token) {
      location.hash = "/";
      return;
    }
    const el = document.createElement("app-home");
    el.setAttribute("token", token);
    app.appendChild(el);
  },
});

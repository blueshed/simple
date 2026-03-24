import { getSession, logout } from "../lib/session";
import { text } from "@blueshed/railroad";

export function AppHome() {
  const { profile } = getSession();

  return (
    <div class="connection-bar">
      <span>{text(() => {
        const p = profile.get() as any;
        return p ? `Hello, ${p.profile.name}` : "Connecting\u2026";
      })}</span>
      <button class="logout" onclick={logout}>Sign out</button>
    </div>
  );
}

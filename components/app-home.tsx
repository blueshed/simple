import { getSession, logout } from "../lib/session";

export function AppHome() {
  const { profile } = getSession();

  return (
    <div class="connection-bar">
      <span>{() => {
        const p = profile.get() as any;
        return p ? `Hello, ${p.profile.name}` : "Connecting\u2026";
      }}</span>
      <button class="logout" onclick={logout}>Sign out</button>
    </div>
  );
}

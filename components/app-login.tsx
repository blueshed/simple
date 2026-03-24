import { auth } from "../lib/session";

export function AppLogin({ onAuthenticated }: { onAuthenticated: (token: string) => void }) {
  const errorEl = <p style="color:red"></p>;

  async function call(fn: string, args: unknown[]) {
    (errorEl as HTMLElement).textContent = "";
    try {
      const { token } = await auth(fn, args);
      onAuthenticated(token);
    } catch (e: any) {
      (errorEl as HTMLElement).textContent = e.message;
    }
  }

  const loginForm = (
    <form onsubmit={async (e: Event) => {
      e.preventDefault();
      const f = e.target as HTMLFormElement;
      await call("login", [f.email.value, f.password.value]);
    }}>
      <h2>Sign in</h2>
      <label>Email <input name="email" type="email" required /></label>
      <label>Password <input name="password" type="password" required /></label>
      <button type="submit">Sign in</button>
      <p><a href="#" onclick={(e: Event) => {
        e.preventDefault();
        (loginForm as HTMLElement).hidden = true;
        (registerForm as HTMLElement).hidden = false;
      }}>Create account</a></p>
    </form>
  );

  const registerForm = (
    <form hidden onsubmit={async (e: Event) => {
      e.preventDefault();
      const f = e.target as HTMLFormElement;
      await call("register", [
        (f.elements.namedItem("name") as HTMLInputElement).value,
        f.email.value,
        f.password.value,
      ]);
    }}>
      <h2>Create account</h2>
      <label>Name <input name="name" type="text" required /></label>
      <label>Email <input name="email" type="email" required /></label>
      <label>Password <input name="password" type="password" required /></label>
      <button type="submit">Register</button>
      <p><a href="#" onclick={(e: Event) => {
        e.preventDefault();
        (loginForm as HTMLElement).hidden = false;
        (registerForm as HTMLElement).hidden = true;
      }}>Sign in instead</a></p>
    </form>
  );

  return (
    <>
      {loginForm}
      {registerForm}
      {errorEl}
    </>
  );
}

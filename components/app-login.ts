// app-login — handles pre-auth: register and login.
// Fires a CustomEvent("authenticated") when the user has a token.

import { auth } from "../session";

class AppLogin extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <form id="login-form">
        <h2>Sign in</h2>
        <label>Email <input name="email" type="email" required /></label>
        <label>Password <input name="password" type="password" required /></label>
        <button type="submit">Sign in</button>
        <p><a href="#" id="show-register">Create account</a></p>
      </form>
      <form id="register-form" hidden>
        <h2>Create account</h2>
        <label>Name <input name="name" type="text" required /></label>
        <label>Email <input name="email" type="email" required /></label>
        <label>Password <input name="password" type="password" required /></label>
        <button type="submit">Register</button>
        <p><a href="#" id="show-login">Sign in instead</a></p>
      </form>
      <p id="error" style="color:red"></p>
    `;

    this.querySelector("#show-register")!.addEventListener("click", (e) => {
      e.preventDefault();
      (this.querySelector("#login-form") as HTMLElement).hidden = true;
      (this.querySelector("#register-form") as HTMLElement).hidden = false;
    });

    this.querySelector("#show-login")!.addEventListener("click", (e) => {
      e.preventDefault();
      (this.querySelector("#login-form") as HTMLElement).hidden = false;
      (this.querySelector("#register-form") as HTMLElement).hidden = true;
    });

    this.querySelector("#login-form")!.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      await this.call("login", [form.email.value, form.password.value]);
    });

    this.querySelector("#register-form")!.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      await this.call("register", [(form.elements.namedItem("name") as HTMLInputElement).value, form.email.value, form.password.value]);
    });
  }

  async call(fn: string, args: unknown[]) {
    const errEl = this.querySelector("#error")!;
    errEl.textContent = "";
    try {
      const { token } = await auth(fn, args);
      this.dispatchEvent(new CustomEvent("authenticated", { detail: { token }, bubbles: true }));
    } catch (e: any) {
      errEl.textContent = e.message;
    }
  }
}

customElements.define("app-login", AppLogin);

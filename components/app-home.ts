// app-home — the authenticated shell.
// Uses getSession() to access the shared WebSocket session.
// Replace the body with your own doc calls and UI.

import { getSession, logout } from "../session";
import { effect } from "../signals";

class AppHome extends HTMLElement {
  private disposers: (() => void)[] = [];

  connectedCallback() {
    const { api, status, profile, openDoc, closeDoc } = getSession();

    this.innerHTML = `
      <div class="connection-bar">
        <span id="welcome">Connecting…</span>
        <button id="logout" class="logout">Sign out</button>
      </div>
      <!-- Add your UI here. -->
    `;

    this.querySelector("#logout")!.addEventListener("click", logout);

    // Render profile once available
    this.disposers.push(effect(() => {
      const p = profile.get() as any;
      if (!p) return;
      this.querySelector("#welcome")!.textContent = `Hello, ${p.profile.name}`;
    }));

    // Example: open a document and react to it
    // const thingId = 1;
    // const doc = openDoc("thing_doc", thingId, null);
    // this.disposers.push(effect(() => {
    //   const data = doc.get() as any;
    //   if (!data) return;
    //   if (data._error) { /* handle error */ return; }
    //   // Patch specific DOM nodes — don't replace innerHTML
    //   this.querySelector("#name")!.textContent = data.thing_doc.name;
    // }));
  }

  disconnectedCallback() {
    this.disposers.forEach(d => d());
    this.disposers = [];
  }
}

customElements.define("app-home", AppHome);

// app-home — the authenticated shell.
// Opens a WebSocket session, exposes the api proxy and profile signal.
// Replace the body with your own doc calls and UI.

import { connect } from "../session";
import { effect } from "../signals";

class AppHome extends HTMLElement {
  connectedCallback() {
    const token = this.getAttribute("token")!;
    const { api, profile, openDoc } = connect(token);

    this.innerHTML = `
      <p id="welcome">Connecting…</p>
      <!-- Add your UI here. Example:
      <button id="load">Load my thing</button>
      -->
    `;

    // Render profile once available
    effect(() => {
      const p = profile.get() as any;
      if (!p) return;
      this.querySelector("#welcome")!.textContent = `Hello, ${p.profile.name}`;
    });

    // Example: open a document and react to it
    // const thingId = 1;
    // const doc = openDoc("thing_doc", thingId, null);
    // effect(() => {
    //   const data = doc.get() as any;
    //   if (!data) return;
    //   this.querySelector("#content")!.textContent = JSON.stringify(data.thing);
    // });
  }
}

customElements.define("app-home", AppHome);

// This is your app's entry point. server-core.ts is the generic infrastructure — don't edit it.
// Configure your app here: which postgres functions are public, and which returns the profile.

import { createServer } from "./server-core";
import { claudeHelperRoute } from "./claude-helper";
import index from "./index.html";

const preAuth = ["login", "register"];

createServer({
  preAuth,
  profileFn: "profile_doc",
  index: index as unknown as Response,
  routes: {
    ...(process.env.RUNTIME_CLAUDE === "true" && {
      "/claude.js": claudeHelperRoute({ preAuth }),
    }),
  },
});

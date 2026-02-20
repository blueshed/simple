// This is your app's entry point. server-core.ts is the generic infrastructure — don't edit it.
// Configure your app here: which postgres functions are public, and which returns the profile.

import { createServer } from "./server-core";
import index from "./index.html";

createServer({
  preAuth: ["login", "register"],
  profileFn: "profile_doc",
  index,
});

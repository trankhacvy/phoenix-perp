import { PrivyClient } from "@privy-io/node";
import { config } from "../config/index.js";

export const privy = new PrivyClient({
  appId: config.PRIVY_APP_ID,
  appSecret: config.PRIVY_APP_SECRET,
});

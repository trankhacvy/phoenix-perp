import { PrivyClient } from "@privy-io/server-auth";
import { config } from "../config/index.js";

export const privy = new PrivyClient(config.PRIVY_APP_ID, config.PRIVY_APP_SECRET, {
  walletApi: {
    // Required for server-side signing (bot-first flow).
    // Generate in Privy Dashboard → Wallets → Authorization Keys.
    authorizationPrivateKey: config.PRIVY_AUTHORIZATION_PRIVATE_KEY,
  },
});

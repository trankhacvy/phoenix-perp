import pino from "pino";
import { config } from "../config/index.js";

export const logger = pino({
  level: config.NODE_ENV === "production" ? "debug" : "debug",
  transport:
    config.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

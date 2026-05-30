import type { FastifyInstance } from "fastify";
import { publicBaseUrl } from "../../bot/lib/share.js";
import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";
import { type PnlCardData, generatePnlCard } from "../../services/image.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadCard(token: string): Promise<PnlCardData | null> {
  const raw = await redis.get(`pnlcard:${token}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PnlCardData;
  } catch {
    return null;
  }
}

export async function cardRoutes(app: FastifyInstance) {
  // Re-render the PNG on demand from the stashed token (1h TTL in Redis).
  app.get<{ Params: { token: string } }>("/card/:token/image.png", async (req, reply) => {
    const data = await loadCard(req.params.token);
    if (!data) return reply.code(404).type("text/plain").send("Card expired");
    try {
      const png = await generatePnlCard(data);
      return reply
        .header("Content-Type", "image/png")
        .header("Cache-Control", "public, max-age=3600")
        .send(png);
    } catch (err) {
      logger.error({ err, token: req.params.token }, "PnL card image render failed");
      return reply.code(500).type("text/plain").send("Render failed");
    }
  });

  // Landing page: crawlers (X/Telegram) read the meta tags and unfurl the image;
  // humans get redirected to the bot via the referral link baked into the card.
  app.get<{ Params: { token: string } }>("/card/:token", async (req, reply) => {
    const { token } = req.params;
    const base = publicBaseUrl();
    const data = await loadCard(token);
    if (!data || !base) {
      return reply.code(404).type("text/html").send("<h1>This card expired.</h1>");
    }

    const imgUrl = `${base}/card/${token}/image.png`;
    const redirect = data.referral?.url ?? "https://t.me";
    const win = data.pnlUsdc >= 0;
    const sign = win ? "+" : "";
    const title = `${data.side.toUpperCase()} ${data.symbol} — ${sign}${data.roiPercent.toFixed(1)}% ROI`;
    const desc = "Realized PnL on SuperNova — trade perps on Solana, right inside Telegram.";

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(imgUrl)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(imgUrl)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta http-equiv="refresh" content="0; url=${esc(redirect)}">
</head>
<body style="font-family:sans-serif;background:#05050F;color:#fff;text-align:center;padding:48px">
Redirecting to SuperNova… <a href="${esc(redirect)}" style="color:#14F195">Open the bot →</a>
</body>
</html>`;

    return reply
      .type("text/html")
      .header("Cache-Control", "public, max-age=3600")
      .send(html);
  });
}

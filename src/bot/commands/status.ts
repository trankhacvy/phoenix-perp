import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { Bot } from "grammy";
import { getAlertWorkerStats } from "../../jobs/processors/alert.js";
import { getLeaderboardStats } from "../../services/leaderboard.js";
import type { BotContext } from "../../types/index.js";
import { getLeaderboardScannerStats } from "../../workers/leaderboard.js";
import { getWsStats } from "../../workers/ws.js";
import { timeAgo } from "../lib/fmt.js";

export function registerStatus(bot: Bot<BotContext>) {
  bot.command("status", async (ctx) => {
    const ws = getWsStats();
    const alert = getAlertWorkerStats();
    const scanner = getLeaderboardScannerStats();
    const lb = await getLeaderboardStats();

    const uptimeSec = Math.floor(process.uptime());
    const uptimeStr =
      uptimeSec < 3600
        ? `${Math.floor(uptimeSec / 60)}m`
        : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;

    const lbUpdated = lb.lastUpdated ? timeAgo(lb.lastUpdated.getTime()) : "never";

    const heapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

    const msg = fmt`⚙️ ${FormattedString.b("System Status")}

${FormattedString.b("Process")}
  Uptime       ${FormattedString.b(uptimeStr)}
  Memory       ${FormattedString.b(`${heapMb} MB`)}

${FormattedString.b("WebSocket")}
  Connections  ${FormattedString.b(String(ws.connections))}
  Own wallets  ${FormattedString.b(String(ws.owners))}
  Monitors     ${FormattedString.b(String(ws.watchers))}

${FormattedString.b("Alert Worker")}
  Status       ${FormattedString.b(alert.running ? "✅ Running" : "❌ Stopped")}

${FormattedString.b("Leaderboard")}
  Scanner      ${FormattedString.b(scanner.isScanning ? "🔄 Scanning" : "💤 Idle")}
  WS feeds     ${FormattedString.b(String(scanner.wsConnections))}
  Traders      ${FormattedString.b(String(lb.totalTraders))}
  Last update  ${FormattedString.b(lbUpdated)}`;

    await ctx.reply(msg.text, { entities: msg.entities });
  });
}

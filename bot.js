// bot-5m-ultimate.js
require("dotenv").config();
const Binance = require("binance-api-node").default;
const { EMA, RSI, MACD, ATR, ADX, Stochastic, PSAR } = require("technicalindicators");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

// ===== Configuration =====
const config = {
  symbol: "BTCUSDT",
  interval: "5m",
  capital: parseFloat(process.env.CAPITAL_USD || "10"),
  riskPerTrade: 0.1,
  compoundRate: 0.07, // 7% compounding
  emaPeriods: [9, 21, 55],
  rsiRange: [48, 62],
  volumeSpike: 2.2,
  adxThreshold: 28,
  sessionHours: [8, 22], // 8AM-10PM UTC
  updateInterval: 300000, // 5 minutes in milliseconds
  trailingStop: {
    activationRatio: 1.5,
    stepSize: 0.3,
    floorRatio: 0.8,
    maxDeviation: 0.02
  }
};

// ===== Initialize Services =====
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET
});

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const LOG_FILE = path.join(__dirname, "logs", "trade-log-ultimate.json");

// ===== State Management =====
let tradingCapital = config.capital;
let position = {
  size: 0,
  entry: null,
  initialStop: null,
  trailingStop: null,
  target: null,
  highestPrice: null,
  atr: null
};
let lastUpdateTime = 0;

// ===== Core Functions =====
async function sendTelegram(msg, parseMode = "") {
  try {
    await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: parseMode });
  } catch (err) {
    console.error("Telegram Error:", err.message);
  }
}

async function logTrade(tradeData) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    ...tradeData,
    capital: tradingCapital,
    positionSize: position.size
  };

  fs.existsSync(path.dirname(LOG_FILE)) || fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const logs = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE)) : [];
  logs.push(logEntry);
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

// ===== Indicator Calculation =====
async function getIndicators() {
  const candles = await client.candles({
    symbol: config.symbol,
    interval: config.interval,
    limit: 300
  });

  const closes = candles.map(c => parseFloat(c.close));
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  const volumes = candles.map(c => parseFloat(c.volume));

  const emas = {};
  config.emaPeriods.forEach(period => {
    emas[`ema${period}`] = EMA.calculate({ period, values: closes });
  });

  return {
    price: closes.at(-1),
    candles,
    ...emas,
    rsi: RSI.calculate({ period: 14, values: closes }),
    macd: MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }),
    atr: ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }),
    adx: ADX.calculate({ high: highs, low: lows, close: closes, period: 14 }),
    stoch: Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 }),
    psar: PSAR.calculate({ high: highs, low: lows, step: 0.02, max: 0.2 }),
    volumeRatio: volumes.at(-1) / (volumes.slice(-20).reduce((a,b) => a + b, 0) / 20)
  };
}

// ===== Trading Logic =====
function shouldEnter(indicators) {
  const hourUTC = new Date().getUTCHours();
  const inSession = hourUTC >= config.sessionHours[0] && hourUTC < config.sessionHours[1];
  const { ema9, ema21, ema55, rsi, macd, adx, stoch, volumeRatio, price } = indicators;

  return (
    inSession &&
    ema9.at(-1) > ema21.at(-1) &&
    ema21.at(-1) > ema55.at(-1) &&
    rsi.at(-1) > config.rsiRange[0] &&
    rsi.at(-1) < config.rsiRange[1] &&
    macd.at(-1).MACD > macd.at(-1).signal * 1.1 &&
    volumeRatio > config.volumeSpike &&
    adx.at(-1) > config.adxThreshold &&
    stoch.at(-1).k > stoch.at(-1).d &&
    price > ema9.at(-1) * 1.002
  );
}

function calculateExit(entryPrice, atr) {
  const initialStop = entryPrice - (atr * 1.2);
  const target = entryPrice + (atr * 2.5);
  
  return {
    initialStop,
    target,
    atr
  };
}

// ===== Trailing Stop Logic =====
function updateTrailingStop(currentPrice) {
  if (!position.trailingStop && 
      currentPrice >= position.entry + (position.atr * config.trailingStop.activationRatio)) {
    position.trailingStop = position.entry + (position.atr * config.trailingStop.floorRatio);
    sendTelegram(`🔔 Trailing Stop Activated at $${position.trailingStop.toFixed(2)}`);
  }

  if (position.trailingStop) {
    const newStop = currentPrice - (position.atr * config.trailingStop.stepSize);
    const minStop = position.entry + (position.atr * config.trailingStop.floorRatio);
    
    if (newStop > position.trailingStop && 
        newStop > minStop &&
        (currentPrice - position.highestPrice) / position.highestPrice < config.trailingStop.maxDeviation) {
      position.trailingStop = newStop;
      position.highestPrice = currentPrice;
    }
  }
}

// ===== Trade Execution =====
async function executeEntry(indicators) {
  const riskAmount = tradingCapital * config.riskPerTrade;
  const size = parseFloat((riskAmount / indicators.price).toFixed(6));
  
  try {
    const order = await client.order({
      symbol: config.symbol,
      side: "BUY",
      type: "MARKET",
      quantity: size
    });

    position = {
      size,
      entry: parseFloat(order.fills[0].price),
      ...calculateExit(parseFloat(order.fills[0].price), indicators.atr.at(-1)),
      highestPrice: parseFloat(order.fills[0].price)
    };

    await logTrade({
      action: "ENTRY",
      price: position.entry,
      size,
      stop: position.initialStop,
      target: position.target
    });

    await sendTelegram(`🚀 *ENTRY SIGNAL* 
Price: $${position.entry.toFixed(2)}
Size: ${size} BTC ($${(size * position.entry).toFixed(2)})
Stop: $${position.initialStop.toFixed(2)} (${((position.entry - position.initialStop)/position.entry*100).toFixed(2)}%)
Target: $${position.target.toFixed(2)} (+${((position.target - position.entry)/position.entry*100).toFixed(2)}%)
ATR: $${position.atr.toFixed(2)}`, "Markdown");

  } catch (err) {
    await sendTelegram(`❌ ENTRY FAILED: ${err.message}`);
    console.error("Entry Error:", err);
  }
}

async function executeExit(reason) {
  try {
    const order = await client.order({
      symbol: config.symbol,
      side: "SELL",
      type: "MARKET",
      quantity: position.size
    });

    const exitPrice = parseFloat(order.fills[0].price);
    const pnlPercent = ((exitPrice - position.entry) / position.entry) * 100;
    
    // Update capital
    if (pnlPercent > 0) {
      tradingCapital *= (1 + config.compoundRate);
    }

    await logTrade({
      action: "EXIT",
      price: exitPrice,
      size: position.size,
      pnl: pnlPercent,
      reason,
      trailingStopUsed: position.trailingStop !== null,
      capital: tradingCapital
    });

    await sendTelegram(`🏁 *EXIT SIGNAL (${reason})* 
Price: $${exitPrice.toFixed(2)}
PnL: ${pnlPercent.toFixed(2)}%
Trailing Stop: ${position.trailingStop ? `$${position.trailingStop.toFixed(2)}` : "Not activated"}
New Capital: $${tradingCapital.toFixed(2)}`, "Markdown");

    // Reset position
    position = { size: 0, entry: null, initialStop: null, trailingStop: null, highestPrice: null, atr: null };

  } catch (err) {
    await sendTelegram(`❌ EXIT FAILED: ${err.message}`);
    console.error("Exit Error:", err);
  }
}

// ===== Market Update Function =====
async function sendMarketUpdate(indicators) {
  const currentPrice = indicators.price;
  const hourUTC = new Date().getUTCHours();
  
  // Don't send updates during off-hours
  if (hourUTC < config.sessionHours[0] || hourUTC >= config.sessionHours[1]) return;

  try {
    await sendTelegram(`📊 *5-Minute Market Update*
🕒 ${new Date().toUTCString().substring(17, 25)} UTC
💰 Price: $${currentPrice.toFixed(2)}
📈 RSI: ${indicators.rsi.at(-1).toFixed(2)} ${indicators.rsi.at(-1) > 50 ? '🟢' : '🔴'}
📊 ADX: ${indicators.adx.at(-1).toFixed(2)} ${indicators.adx.at(-1) > 25 ? '🔺' : '🔻'}
💎 Volume: ${(indicators.volumeRatio*100).toFixed(2)}% of avg
${position.size ? 
  `⚖️ Position: ${position.size} BTC (${((currentPrice - position.entry)/position.entry*100).toFixed(2)}%)
🎯 Target: $${position.target.toFixed(2)} (+${((position.target - position.entry)/position.entry*100).toFixed(2)}%)
🛑 Stop: $${position.initialStop.toFixed(2)} (${((position.entry - position.initialStop)/position.entry*100).toFixed(2)}%)` 
  : "🚫 No active position"}`, "Markdown");
  } catch (err) {
    console.error("Market Update Error:", err);
  }
}

// ===== Main Loop =====
async function checkMarket() {
  try {
    const ind = await getIndicators();
    const currentPrice = ind.price;
    const now = Date.now();

    // Send 5-minute market updates
    if (now - lastUpdateTime >= config.updateInterval) {
      await sendMarketUpdate(ind);
      lastUpdateTime = now;
    }

    // Update trailing stop if in position
    if (position.size > 0) {
      updateTrailingStop(currentPrice);

      // Check exit conditions (in priority order)
      if (currentPrice <= position.initialStop) {
        await executeExit("HARD STOP");
      } else if (position.trailingStop && currentPrice <= position.trailingStop) {
        await executeExit("TRAILING STOP");
      } else if (currentPrice >= position.target) {
        await executeExit("TAKE PROFIT");
      } else if (ind.ema9.at(-1) < ind.ema21.at(-1)) {
        await executeExit("EMA CROSS");
      } else if (ind.psar.at(-1) > currentPrice) {
        await executeExit("PSAR REVERSAL");
      }
    }

    // Check entry conditions
    if (shouldEnter(ind) && !position.size) {
      await executeEntry(ind);
    }

  } catch (err) {
    await sendTelegram(`⚠️ SYSTEM ERROR: ${err.message}`);
    console.error("Main Loop Error:", err);
  }
}

// ===== Startup =====
(async () => {
  // Verify connectivity
  await sendTelegram("🤖 *Ultimate 5m Bot Starting...*", "Markdown");
  
  try {
    const time = await client.time();
    await sendTelegram(`✅ Binance API Connected\nServer Time: ${new Date(time).toUTCString()}`);
  } catch (err) {
    await sendTelegram(`❌ Binance Connection Failed: ${err.message}`);
    process.exit(1);
  }

  // Initialize
  fs.existsSync(path.dirname(LOG_FILE)) || fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  
  // Start main loop (every 1 minute for precise 5-minute updates)
  setInterval(checkMarket, 60 * 1000);
  await checkMarket(); // Immediate first check

  await sendTelegram(`🚀 *Bot Activated - Monitoring ${config.symbol} ${config.interval}*
💰 Starting Capital: $${tradingCapital.toFixed(2)}
⚡ 5-minute updates enabled`, "Markdown");
})();

// ===== Telegram Commands =====
bot.onText(/\/status/, async (msg) => {
  const ind = await getIndicators();
  const status = position.size ? `
🟢 *IN POSITION*
Entry: $${position.entry.toFixed(2)}
Current: $${ind.price.toFixed(2)} (${((ind.price - position.entry)/position.entry*100).toFixed(2)}%)
Stop: $${position.initialStop.toFixed(2)}
${position.trailingStop ? `Trailing: $${position.trailingStop.toFixed(2)}` : ""}
Size: ${position.size} BTC ($${(position.size * ind.price).toFixed(2)})
Capital: $${tradingCapital.toFixed(2)}
  ` : `
🔴 *NO POSITION*
Capital: $${tradingCapital.toFixed(2)}
Last Price: $${ind.price.toFixed(2)}
  `;
  
  await bot.sendMessage(msg.chat.id, status, { parse_mode: "Markdown" });
});

bot.onText(/\/logs(?: (\d+))?/, async (msg, match) => {
  const limit = match && match[1] ? parseInt(match[1]) : 5;
  
  if (fs.existsSync(LOG_FILE)) {
    const logs = JSON.parse(fs.readFileSync(LOG_FILE));
    const lastTrades = logs.slice(-limit).reverse().map(log => `
📅 ${new Date(log.timestamp).toLocaleString()}
${log.action === "ENTRY" ? "🟢" : "🔴"} ${log.action} ${log.size} BTC @ $${log.price.toFixed(2)}
${log.pnl ? `📈 PnL: ${log.pnl.toFixed(2)}%` : ""}
${log.reason ? `⚡ Reason: ${log.reason}` : ""}
${log.trailingStopUsed ? `🎯 Trailing Stop Used` : ""}
    `).join("\n");
    
    await bot.sendMessage(msg.chat.id, `📜 *Last ${limit} Trades*\n${lastTrades}`, { parse_mode: "Markdown" });
  } else {
    await bot.sendMessage(msg.chat.id, "No trades logged yet.");
  }
});

// ===== Error Handling =====
process.on("uncaughtException", async (err) => {
  await sendTelegram(`💥 CRASH: Uncaught Exception\n${err.stack || err.message}`);
  console.error("Uncaught Exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", async (err) => {
  await sendTelegram(`💥 CRASH: Unhandled Rejection\n${err.stack || err.message}`);
  console.error("Unhandled Rejection:", err);
  process.exit(1);
});
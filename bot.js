// bot.js
require('dotenv').config();
const Binance = require('binance-api-node').default;
const { EMA, RSI, MACD, ATR } = require('technicalindicators');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// === Setup ===
let buySignalPending = false;
let sellSignalPending = false;
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CAPITAL = parseFloat(process.env.CAPITAL_USD || '10');
const SYMBOL = 'BTCUSDT';
const INTERVAL = '1h';
const LOG_FILE = path.join(__dirname, 'logs', 'trade-log.json');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
let lastBuyPrice = null;
let inPosition = false;

const sendTelegram = async (msg) => {
  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, msg);
  } catch (err) {
    console.error('Telegram Error:', err.message);
  }
};

// === Telegram Commands ===
bot.onText(/\/start/, (msg) => {
  if (msg.chat.id.toString() === TELEGRAM_CHAT_ID) {
    sendTelegram('🤖 Bot is running and monitoring BTC/USDT.');
  }
});

bot.onText(/\/help/, (msg) => {
  const helpText = `📘 *Bot Commands:*
/start - Show bot status
/help - Show this help message
/status - Show current trade state
/logs - Show last trade log`;
  bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, async (msg) => {
  let text = inPosition
    ? `✅ Currently in position\nEntry Price: $${lastBuyPrice}`
    : '📭 Not in any position.';
  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/logs/, (msg) => {
  if (fs.existsSync(LOG_FILE)) {
    const logs = JSON.parse(fs.readFileSync(LOG_FILE));
    const last = logs[logs.length - 1];
    bot.sendMessage(msg.chat.id, `📜 Last Trade:\nSide: ${last.side}\nPrice: $${last.price}\nQty: ${last.qty}\nTime: ${last.time}`);
  } else {
    bot.sendMessage(msg.chat.id, '📭 No trades logged yet.');
  }
});

const logTrade = (trade) => {
  try {
    if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    let logs = [];
    if (fs.existsSync(LOG_FILE)) {
      logs = JSON.parse(fs.readFileSync(LOG_FILE));
    }
    logs.push(trade);
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
  } catch (err) {
    console.error('Logging Error:', err.message);
  }
};

const round = (val, dec = 6) => Number(parseFloat(val).toFixed(dec));

const checkSignal = async () => {
  try {
    const candles = await client.candles({ symbol: SYMBOL, interval: INTERVAL, limit: 150 });
    const closes = candles.map(c => parseFloat(c.close));
    const highs = candles.map(c => parseFloat(c.high));
    const lows = candles.map(c => parseFloat(c.low));
    const volumes = candles.map(c => parseFloat(c.volume));

    const ema20 = EMA.calculate({ period: 20, values: closes });
    const ema50 = EMA.calculate({ period: 50, values: closes });
    const ema200 = EMA.calculate({ period: 200, values: closes });
    const rsi = RSI.calculate({ period: 14, values: closes });
    const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }) || [];
    const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });

    const i = closes.length - 1;
    const price = closes[i];

    const isUptrend = ema20.at(-1) > ema50.at(-1) && ema50.at(-1) > ema200.at(-1);
    const isRSIPullback = rsi.at(-2) < 40 && rsi.at(-1) > 45;
    const isMACDCross = macd.at(-1)?.MACD > macd.at(-1)?.signal;
    const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const isVolumeSpike = volumes.at(-1) > 1.5 * avgVolume;

    const shouldBuy = isUptrend && isRSIPullback && isMACDCross && isVolumeSpike && !inPosition;
    const shouldSell = inPosition && (
      price <= lastBuyPrice - atr.at(-1) ||
      price >= lastBuyPrice + atr.at(-1) * 2
    );

    if (shouldBuy && !buySignalPending) {
      buySignalPending = true;
      const qty = round(CAPITAL / price);
      await sendTelegram(`📥 Buy Signal Triggered
Price: $${price}
Qty: ${qty}
Strategy: EMA+RSI+MACD+ATR
Buying in 1 min...`);
      setTimeout(async () => {
        await client.order({ symbol: SYMBOL, side: 'BUY', type: 'MARKET', quantity: qty });
        inPosition = true;
        lastBuyPrice = price;
        logTrade({ side: 'BUY', price, qty, time: new Date().toISOString() });
        await sendTelegram(`✅ Bought $${SYMBOL} at $${price} (Qty: ${qty})`);
        buySignalPending = false;
      }, 60000);
    } else if (shouldSell && !sellSignalPending) {
      sellSignalPending = true;
      await sendTelegram(`📤 Sell Signal Triggered
Price: $${price}
Selling in 1 min...`);
      setTimeout(async () => {
        const balance = await client.accountInfo();
        const asset = balance.balances.find(b => b.asset === 'BTC');
        const qty = round(parseFloat(asset?.free || '0'));
        if (qty > 0) {
          await client.order({ symbol: SYMBOL, side: 'SELL', type: 'MARKET', quantity: qty });
          inPosition = false;
          logTrade({ side: 'SELL', price, qty, time: new Date().toISOString() });
          await sendTelegram(`✅ Sold $${SYMBOL} at $${price} (Qty: ${qty})`);
        }
        sellSignalPending = false;
      }, 60000);
    }

    await sendTelegram(`📊 Indicator Check:
EMA20: ${ema20.at(-1)?.toFixed(2)}
EMA50: ${ema50.at(-1)?.toFixed(2)}
EMA200: ${ema200.at(-1)?.toFixed(2)}
RSI: ${rsi.at(-1)?.toFixed(2)}
MACD: ${macd.at(-1)?.MACD?.toFixed(4)}
Signal: ${macd.at(-1)?.signal?.toFixed(4)}
ATR: ${atr.at(-1)?.toFixed(2)}`);
  } catch (err) {
    console.error('Error in checkSignal:', err.message);
    await sendTelegram(`⚠️ Error: ${err.message}`);
  }
};

setInterval(checkSignal, 60 * 60 * 1000);
sendTelegram('🤖 Bot started with EMA+RSI+MACD+ATR strategy and auto trading enabled.');
checkSignal();
checkSignal();

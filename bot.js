require('dotenv').config();
const Binance = require('binance-api-node').default;
const { EMA, RSI, MACD } = require('technicalindicators');
const TelegramBot = require('node-telegram-bot-api');

// === Load ENV ===
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CAPITAL = parseFloat(process.env.CAPITAL_USD || '10');

const bot = new TelegramBot(TELEGRAM_TOKEN);

// === CONFIG ===
const SYMBOL = 'BTCUSDT';
const INTERVAL = '1h'; // you can change to '5m' for faster testing
const SL_PERCENT = 1;      // Stop Loss %
const TP_PERCENT = 3;      // Take Profit %
const TRAIL_SL_PERCENT = 1.5; // Trailing Stop %

let lastBuyPrice = null;
let highestPriceSinceBuy = null;

// === HELPERS ===
const sendTelegram = async (msg) => {
  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, msg);
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
};

const round = (val, dec = 8) => Number(parseFloat(val).toFixed(dec));

// === MAIN CHECK FUNCTION ===
const checkSignal = async () => {
  try {
    const candles = await client.candles({ symbol: SYMBOL, interval: INTERVAL, limit: 100 });
    const closes = candles.map(c => parseFloat(c.close));
    const volumes = candles.map(c => parseFloat(c.volume));

    const ema20 = EMA.calculate({ period: 20, values: closes });
    const ema50 = EMA.calculate({ period: 50, values: closes });
    const ema200 = EMA.calculate({ period: 200, values: closes });

    const rsi = RSI.calculate({ period: 14, values: closes });
    const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });

    const i = closes.length - 1;

    const isUptrend = ema20[i - 1] > ema50[i - 1] && ema50[i - 1] > ema200[i - 1];
    const isRSIPullback = rsi[i - 2] < 40 && rsi[i - 1] > 45;
    const isMACDCross = macd[i - 1]?.MACD > macd[i - 1]?.signal;
    const avgVolume = volumes.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20;
    const isVolumeSpike = volumes[i - 1] > 1.5 * avgVolume;

    // === DEBUG LOGGING ===
    console.log({
      isUptrend,
      isRSIPullback,
      isMACDCross,
      isVolumeSpike
    });

    // === BUY Signal ===
    if (isUptrend && isRSIPullback && isMACDCross && isVolumeSpike && !lastBuyPrice) {
      const { price: currentPrice } = await client.prices({ symbol: SYMBOL });
      const price = parseFloat(currentPrice);

      const qty = round(CAPITAL / price, 6);
      await client.order({ symbol: SYMBOL, side: 'BUY', type: 'MARKET', quantity: qty });

      lastBuyPrice = price;
      highestPriceSinceBuy = price;

      sendTelegram(`✅ BUY ORDER\nPrice: $${price}\nQty: ${qty}\nStrategy: EMA+RSI+MACD+Volume`);
    }

    // === SELL Conditions ===
    if (lastBuyPrice) {
      const { price: currentPrice } = await client.prices({ symbol: SYMBOL });
      const price = parseFloat(currentPrice);

      if (price > highestPriceSinceBuy) highestPriceSinceBuy = price;

      const slPrice = lastBuyPrice * (1 - SL_PERCENT / 100);
      const tpPrice = lastBuyPrice * (1 + TP_PERCENT / 100);
      const trailingSL = highestPriceSinceBuy * (1 - TRAIL_SL_PERCENT / 100);

      if (price <= slPrice || price >= tpPrice || price <= trailingSL) {
        const account = await client.accountInfo();
        const btcAsset = account.balances.find(b => b.asset === 'BTC');
        const qty = round(parseFloat(btcAsset.free), 6);

        if (qty > 0.00001) {
          await client.order({ symbol: SYMBOL, side: 'SELL', type: 'MARKET', quantity: qty });

          sendTelegram(`🚨 SELL ORDER\nPrice: $${price}\nQty: ${qty}\nReason: ${
            price <= slPrice ? 'Stop Loss' : price >= tpPrice ? 'Take Profit' : 'Trailing Stop Hit'
          }`);

          lastBuyPrice = null;
          highestPriceSinceBuy = null;
        }
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
    sendTelegram(`⚠️ Bot Error: ${err.message}`);
  }
};

// === LOOP ===
setInterval(checkSignal, 60 * 60 * 1000); // every 1 hour

// Run once on startup
checkSignal();
sendTelegram('🤖 Bot Started: Watching BTC/USDT every 1 hour...');
console.log('Bot running... watching BTC/USDT');

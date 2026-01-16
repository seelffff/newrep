import WebSocket from 'ws';
import type { TickerPrice, TradingPair } from '../types/exchange.js';
import { Logger } from '../utils/logger.js';
import type { WebSocketMonitor } from '../utils/websocket-monitor.js';

/**
 * Интерфейс ответа MEXC ticker API
 */
interface MexcTickerResponse {
  success: boolean;
  code: number;
  data: Array<{
    symbol: string;
    lastPrice: number;
    bid1: number;
    ask1: number;
    volume24: number;
    amount24: number;
    holdVol: number;
    riseFallRate: number;
    timestamp: number;
  }>;
}

/**
 * Интерфейс ответа MEXC contract detail API
 * (для будущего использования)
 */
// interface MexcContractResponse {
//   success: boolean;
//   code: number;
//   data: Array<{
//     symbol: string;
//     displayName: string;
//     baseCoin: string;
//     quoteCoin: string;
//   }>;
// }

/**
 * Класс для работы с MEXC Futures API
 * Документация: https://mexcdevelop.github.io/apidocs/contract_v1_en/
 */
export class MexcFutures {
  private restBaseUrl: string;
  private wsBaseUrl: string;
  private logger: Logger;
  private ws: WebSocket | null = null;
  private priceCache: Map<string, TickerPrice> = new Map();
  private reconnectDelay: number;
  private pingInterval: NodeJS.Timeout | null = null;
  private wsMonitor: WebSocketMonitor | null = null;

  constructor(
    restBaseUrl: string,
    wsBaseUrl: string,
    reconnectDelay = 3000,
    logger?: Logger,
    wsMonitor?: WebSocketMonitor
  ) {
    this.restBaseUrl = restBaseUrl;
    this.wsBaseUrl = wsBaseUrl;
    this.reconnectDelay = reconnectDelay;
    this.logger = logger || new Logger();
    this.wsMonitor = wsMonitor || null;
  }

  /**
   * Получить топ N торговых пар по объему через REST API
   * Endpoint: GET /api/v1/contract/ticker
   */
  async getTopPairs(limit = 50): Promise<TradingPair[]> {
    try {
      const url = `${this.restBaseUrl}/api/v1/contract/ticker`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`MEXC API error: ${response.status} ${response.statusText}`);
      }

      const json = (await response.json()) as MexcTickerResponse;

      if (!json.success || !json.data) {
        throw new Error('MEXC API returned unsuccessful response');
      }

      // Фильтруем только USDT пары и сортируем по объему
      const usdtPairs = json.data
        .filter((ticker) => ticker.symbol.endsWith('_USDT'))
        .sort((a, b) => b.amount24 - a.amount24) // amount24 = объем в USDT
        .slice(0, limit);

      return usdtPairs.map((ticker) => ({
        symbol: ticker.symbol,
        baseAsset: ticker.symbol.replace('_USDT', ''),
        quoteAsset: 'USDT',
        volume24h: ticker.amount24,
      }));
    } catch (error) {
      this.logger.error(
        `MEXC: Ошибка получения топ пар - ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Подключиться к WebSocket и подписаться на ticker для списка символов
   * Документация: https://mexcdevelop.github.io/apidocs/contract_v1_en/#websocket-market-streams
   */
  connectWebSocket(symbols: string[], onPriceUpdate?: (price: TickerPrice) => void): void {
    if (this.ws) {
      this.logger.warn('MEXC: WebSocket уже подключен');
      return;
    }

    this.logger.info(`MEXC: Подключение к WebSocket (${symbols.length} символов)...`);

    this.ws = new WebSocket(this.wsBaseUrl);

    this.ws.on('open', () => {
      this.logger.success(`MEXC: WebSocket подключен`);

      // MEXC требует подписаться на каждый символ отдельно
      // Формат: {"method":"sub.ticker","param":{"symbol":"BTC_USDT"}}
      symbols.forEach((symbol) => {
        const subscribeMsg = {
          method: 'sub.ticker',
          param: {
            symbol: symbol,
          },
        };

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify(subscribeMsg));
        }
      });

      this.logger.success(`MEXC: Подписка на ${symbols.length} пар отправлена`);
      this.startPingInterval();
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString());

        // MEXC отправляет данные в формате: { channel: "push.ticker", data: {...} }
        if (parsed.channel === 'push.ticker' && parsed.data) {
          const ticker = parsed.data;

          const price: TickerPrice = {
            symbol: ticker.symbol, // Symbol (например "BTC_USDT")
            price: parseFloat(ticker.lastPrice), // Последняя цена
            bid: parseFloat(ticker.bid1), // Лучшая цена покупки
            ask: parseFloat(ticker.ask1), // Лучшая цена продажи
            timestamp: ticker.timestamp || Date.now(),
            exchange: 'mexc',
          };

          // Обновляем кэш
          this.priceCache.set(price.symbol, price);

          // Вызываем callback если передан
          if (onPriceUpdate) {
            onPriceUpdate(price);
          }
        }
        // Обрабатываем подтверждение подписки
        else if (parsed.channel === 'rs.sub.ticker') {
          // Подписка успешна
          if (parsed.data && parsed.data.length > 0) {
            this.logger.info(`MEXC: Подписка подтверждена для ${parsed.data[0]}`);
          }
        }
      } catch (error) {
        this.logger.error(
          `MEXC: Ошибка парсинга WS сообщения - ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });

    this.ws.on('error', (error) => {
      this.logger.error(`MEXC: WebSocket ошибка - ${error.message}`);
      // Записываем ошибку в монитор
      if (this.wsMonitor) {
        this.wsMonitor.recordDisconnect('mexc', `Error: ${error.message}`);
      }
    });

    this.ws.on('close', (code, reason) => {
      const reasonText = reason.toString() || `Code: ${code}`;
      this.logger.warn(`MEXC: WebSocket отключен (${reasonText})`);

      // Записываем отключение в монитор
      if (this.wsMonitor) {
        this.wsMonitor.recordDisconnect('mexc', reasonText);
      }

      this.cleanup();

      // Автопереподключение
      this.logger.info(`MEXC: Переподключение через ${this.reconnectDelay}ms...`);
      setTimeout(() => {
        this.connectWebSocket(symbols, onPriceUpdate);
      }, this.reconnectDelay);
    });

    this.ws.on('open', () => {
      this.logger.success('MEXC: WebSocket подключен');

      // Записываем переподключение в монитор
      if (this.wsMonitor) {
        this.wsMonitor.recordReconnect('mexc');
      }
    });

    this.ws.on('ping', () => {
      // MEXC отправляет ping, отвечаем pong
      if (this.ws) {
        this.ws.pong();
      }
    });
  }

  /**
   * MEXC требует ping каждые 10-20 секунд
   * Соединение разрывается при отсутствии ping в течение 1 минуты
   */
  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Отправляем ping сообщение
        this.ws.ping();
      }
    }, 15000); // Каждые 15 секунд
  }

  /**
   * Получить текущую цену из кэша
   */
  getPrice(symbol: string): TickerPrice | undefined {
    return this.priceCache.get(symbol);
  }

  /**
   * Получить все цены из кэша
   */
  getAllPrices(): Map<string, TickerPrice> {
    return this.priceCache;
  }

  /**
   * Отключиться от WebSocket
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.cleanup();
      this.logger.info('MEXC: WebSocket отключен вручную');
    }
  }

  /**
   * Очистка ресурсов
   */
  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.ws = null;
  }

  /**
   * Проверить доступность API
   */
  async healthCheck(): Promise<boolean> {
    try {
      const url = `${this.restBaseUrl}/api/v1/contract/ping`;
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Конвертировать символ MEXC в формат Binance
   * MEXC: BTC_USDT -> Binance: BTCUSDT
   */
  static toCommonFormat(mexcSymbol: string): string {
    return mexcSymbol.replace('_', '');
  }

  /**
   * Конвертировать символ Binance в формат MEXC
   * Binance: BTCUSDT -> MEXC: BTC_USDT
   */
  static toMexcFormat(binanceSymbol: string): string {
    // Убираем USDT и добавляем _USDT
    return binanceSymbol.replace('USDT', '_USDT');
  }
}

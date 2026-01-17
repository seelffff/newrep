/**
 * Типы данных бирж
 */

export type ExchangeName = 'binance' | 'mexc';

/**
 * Цена пары на бирже
 */
export interface TickerPrice {
  symbol: string;        // Символ пары, например "BTCUSDT"
  price: number;         // Текущая цена
  bid: number;           // Лучшая цена покупки
  ask: number;           // Лучшая цена продажи
  timestamp: number;     // Время получения данных (Unix timestamp)
  exchange: ExchangeName; // Название биржи
}

/**
 * Информация о торговой паре
 */
export interface TradingPair {
  symbol: string;          // Символ пары
  baseAsset: string;       // Базовая валюта (BTC в BTCUSDT)
  quoteAsset: string;      // Котируемая валюта (USDT в BTCUSDT)
  volume24h?: number;      // Объем за 24 часа
}

/**
 * Арбитражная возможность
 */
export interface ArbitrageOpportunity {
  symbol: string;
  buyExchange: ExchangeName;   // Где покупать (дешевле)
  sellExchange: ExchangeName;  // Где продавать (дороже)
  buyPrice: number;
  sellPrice: number;
  spreadPercent: number;       // Разница в процентах
  profitPercent: number;       // Прибыль после вычета комиссий
  timestamp: number;
}

/**
 * Статистика 24h для пары
 */
export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  volume: number;
  quoteVolume: number;
  priceChange: number;
  priceChangePercent: number;
  high: number;
  low: number;
}

/**
 * Тип позиции
 */
export type PositionSide = 'LONG' | 'SHORT';

/**
 * Статус позиции
 */
export type PositionStatus = 'OPEN' | 'CLOSED' | 'TIMEOUT_CLOSED';

/**
 * Открытая позиция на бирже
 */
export interface Position {
  id: string;                     // Уникальный ID позиции
  symbol: string;                 // Торговая пара
  exchange: ExchangeName;         // Биржа
  side: PositionSide;             // LONG или SHORT
  entryPrice: number;             // Цена входа
  exitPrice?: number;             // Цена выхода (если закрыта)
  quantity: number;               // Количество контрактов
  sizeUSD: number;                // Размер позиции в USD
  leverage: number;               // Плечо
  status: PositionStatus;         // Статус позиции
  openTime: number;               // Время открытия (timestamp)
  closeTime?: number;             // Время закрытия (timestamp)
  pnl?: number;                   // Прибыль/убыток в USD
  pnlPercent?: number;            // Прибыль/убыток в %
}

/**
 * Пара позиций (арбитражная пара)
 */
export interface PositionPair {
  id: string;                     // Уникальный ID пары
  symbol: string;                 // Торговая пара
  longPosition: Position;         // LONG позиция (дешевая биржа)
  shortPosition: Position;        // SHORT позиция (дорогая биржа)
  openSpread: number;             // Спред при открытии
  currentSpread?: number;         // Текущий спред
  expectedProfit: number;         // Ожидаемая прибыль %
  actualProfit?: number;          // Фактическая прибыль %
  status: PositionStatus;         // Статус пары
  openTime: number;               // Время открытия
  closeTime?: number;             // Время закрытия
  timeoutAt: number;              // Время автозакрытия по таймауту
}

/**
 * Причина пропуска арбитражной возможности
 */
export type SkipReason =
  | 'INSUFFICIENT_BALANCE'
  | 'POSITION_NOT_PROFITABLE'
  | 'NO_FREE_SLOTS'
  | 'SYMBOL_ALREADY_OPEN'
  | 'PROFIT_BELOW_THRESHOLD'
  | 'SPREAD_CLOSED'
  | 'LIQUIDITY_LOW';

/**
 * Пропущенная арбитражная возможность
 */
export interface SkippedOpportunity {
  timestamp: number;
  symbol: string;
  buyExchange: ExchangeName;
  sellExchange: ExchangeName;
  buyPrice: number;
  sellPrice: number;
  spreadPercent: number;
  profitPercent: number;
  reason: SkipReason;
  availableBalance?: number;
  requiredBalance?: number;
  currentPositionProfit?: number;
}

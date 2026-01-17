import type { TickerPrice, ArbitrageOpportunity } from './types/exchange.js';
import type { Config } from './types/config.js';
import { Logger } from './utils/logger.js';
import { BinanceFutures } from './exchanges/binance-futures.js';
import { MexcFutures } from './exchanges/mexc-futures.js';
import { TradeExecutor } from './trade-executor.js';
import { WebSocketMonitor } from './utils/websocket-monitor.js';
import { ExcelReporter } from './utils/excel-reporter.js';

/**
 * Класс для детектирования арбитражных возможностей между биржами
 */

/**
 * Форматировать процент, избегая -0.00%
 */
function formatPercent(value: number, decimals: number = 2): string {
  // Если значение очень близко к нулю, показываем как 0.00%
  if (Math.abs(value) < 0.005) {
    return '0.00';
  }
  return value.toFixed(decimals);
}

export class ArbitrageDetector {
  private config: Config;
  private logger: Logger;
  private binance: BinanceFutures;
  private mexc: MexcFutures;
  private tradeExecutor: TradeExecutor;
  private commonSymbols: string[] = [];
  private wsMonitor: WebSocketMonitor;
  private excelReporter: ExcelReporter;
  private sessionStartTime: number;

  // Счетчики статистики
  private opportunitiesFound = 0;
  private totalComparisons = 0;

  constructor(config: Config, logger?: Logger) {
    this.config = config;
    this.logger = logger || new Logger(config.notifications.coloredOutput);
    this.sessionStartTime = Date.now();

    // Инициализируем WebSocket монитор
    this.wsMonitor = new WebSocketMonitor();

    // Инициализируем Excel reporter
    this.excelReporter = new ExcelReporter(this.logger);

    // Инициализируем биржи с монитором
    this.binance = new BinanceFutures(
      config.exchanges.binance.restBaseUrl,
      config.exchanges.binance.wsBaseUrl,
      config.arbitrage.reconnectDelayMs,
      this.logger,
      this.wsMonitor
    );

    this.mexc = new MexcFutures(
      config.exchanges.mexc.restBaseUrl,
      config.exchanges.mexc.wsBaseUrl,
      config.arbitrage.reconnectDelayMs,
      this.logger,
      this.wsMonitor
    );

    // Инициализируем трейд-исполнитель
    this.tradeExecutor = new TradeExecutor(config, this.logger);

    // Связываем функцию получения цен для закрытия по таймауту
    this.tradeExecutor.setPriceGetter((symbol: string) => this.getCurrentPrices(symbol));
  }

  /**
   * Запустить мониторинг арбитража
   */
  async start(): Promise<void> {
    this.logger.header('🚀 ЗАПУСК АРБИТРАЖНОГО БОТА');

    // 1. Проверяем доступность бирж
    await this.checkExchangesHealth();

    // 2. Получаем топ пары с обеих бирж
    await this.fetchTopPairs();

    // 3. Запускаем трейд-исполнитель (если торговля включена)
    this.tradeExecutor.start();

    // 4. Запускаем минутные сводки
    this.startMinuteSummary();

    // 5. Подключаемся к WebSocket
    if (this.config.arbitrage.useWebSocket) {
      await this.startWebSocketMonitoring();
    } else {
      this.logger.warn(
        'WebSocket отключен! Арбитраж будет работать медленно через REST API.'
      );
      // TODO: Реализовать REST polling если нужно
    }
  }

  /**
   * Проверить доступность бирж
   */
  private async checkExchangesHealth(): Promise<void> {
    this.logger.info('Проверка доступности бирж...');

    const binanceOk = await this.binance.healthCheck();
    const mexcOk = await this.mexc.healthCheck();

    if (binanceOk) {
      this.logger.success('Binance API доступен');
    } else {
      this.logger.error('Binance API недоступен!');
      throw new Error('Binance API недоступен');
    }

    if (mexcOk) {
      this.logger.success('MEXC API доступен');
    } else {
      this.logger.error('MEXC API недоступен!');
      throw new Error('MEXC API недоступен');
    }
  }

  /**
   * Пол��чить топ торговые пары с обеих бирж
   */
  private async fetchTopPairs(): Promise<void> {
    this.logger.info(
      `Получение топ ${this.config.arbitrage.topPairsCount} торговых пар...`
    );

    const [binancePairs, mexcPairs] = await Promise.all([
      this.binance.getTopPairs(this.config.arbitrage.topPairsCount),
      this.mexc.getTopPairs(this.config.arbitrage.topPairsCount),
    ]);

    this.logger.success(`Binance: получено ${binancePairs.length} пар`);
    this.logger.success(`MEXC: получено ${mexcPairs.length} пар`);

    // Находим общие символы (в формате Binance BTCUSDT)
    const binanceSymbols = new Set(binancePairs.map((p) => p.symbol));
    const mexcSymbolsConverted = new Set(
      mexcPairs.map((p) => MexcFutures.toCommonFormat(p.symbol))
    );

    this.commonSymbols = Array.from(binanceSymbols).filter((symbol) =>
      mexcSymbolsConverted.has(symbol)
    );

    // Исключаем пары из конфига
    if (this.config.arbitrage.excludePairs.length > 0) {
      const beforeCount = this.commonSymbols.length;
      this.commonSymbols = this.commonSymbols.filter(
        (s) => !this.config.arbitrage.excludePairs.includes(s)
      );
      const excluded = beforeCount - this.commonSymbols.length;
      if (excluded > 0) {
        this.logger.info(`Исключено ${excluded} пар по конфигу`);
      }
    }

    this.logger.success(
      `Найдено ${this.commonSymbols.length} общих пар для мониторинга`
    );

    if (this.commonSymbols.length === 0) {
      throw new Error(
        'Не найдено общих торговых пар между биржами! Проверьте настройки.'
      );
    }

    // Выводим топ-10 для информации
    this.logger.info('\nТоп-10 отслеживаемых пар:');
    this.commonSymbols.slice(0, 10).forEach((symbol, i) => {
      console.log(`  ${i + 1}. ${symbol}`);
    });
    console.log('');
  }

  /**
   * Запустить мониторинг через WebSocket
   */
  private async startWebSocketMonitoring(): Promise<void> {
    this.logger.info('Подключение к WebSocket обеих бирж...');

    // Конвертируем символы в формат MEXC (BTC_USDT)
    const mexcSymbols = this.commonSymbols.map((s) => MexcFutures.toMexcFormat(s));

    // Подключаемся к обеим биржам
    this.binance.connectWebSocket(this.commonSymbols, (price) =>
      this.onPriceUpdate(price)
    );

    this.mexc.connectWebSocket(mexcSymbols, (price) => this.onPriceUpdate(price));

    this.logger.success('WebSocket мониторинг запущен!');
    this.logger.separator();
    this.logger.info(
      `Минимальный спред для детектирования: ${this.config.arbitrage.minSpreadPercent}%`
    );
    this.logger.info(
      `Минимальный спред для уведомления: ${this.config.notifications.minSpreadToNotify}%`
    );
    this.logger.separator();
    console.log('\n🔍 Ожидание арбитражных возможностей...\n');
  }

  /**
   * Обработчик обновления цены
   */
  private onPriceUpdate(price: TickerPrice): void {
    // Получаем цену с другой биржи
    const normalizedSymbol = MexcFutures.toCommonFormat(price.symbol);

    let otherPrice: TickerPrice | undefined;

    if (price.exchange === 'binance') {
      // Получаем цену с MEXC
      const mexcSymbol = MexcFutures.toMexcFormat(normalizedSymbol);
      otherPrice = this.mexc.getPrice(mexcSymbol);
    } else {
      // Получаем цену с Binance
      otherPrice = this.binance.getPrice(normalizedSymbol);
    }

    // Если цена на другой бирже еще не пришла, пропускаем
    if (!otherPrice) {
      return;
    }

    // Проверяем арбитраж
    this.checkArbitrage(price, otherPrice, normalizedSymbol);
  }

  /**
   * Проверить арбитражную возможность между двумя ценами
   */
  private checkArbitrage(
    price1: TickerPrice,
    price2: TickerPrice,
    symbol: string
  ): void {
    this.totalComparisons++;

    // Определяем где дешевле, где дороже
    // Для покупки используем ask (цена продавца)
    // Для продажи используем bid (цена покупателя)

    let buyExchange: 'binance' | 'mexc';
    let sellExchange: 'binance' | 'mexc';
    let buyPrice: number;
    let sellPrice: number;

    if (price1.ask < price2.bid) {
      // Покупаем на price1, продаем на price2
      buyExchange = price1.exchange;
      sellExchange = price2.exchange;
      buyPrice = price1.ask;
      sellPrice = price2.bid;
    } else if (price2.ask < price1.bid) {
      // Покупаем на price2, продаем на price1
      buyExchange = price2.exchange;
      sellExchange = price1.exchange;
      buyPrice = price2.ask;
      sellPrice = price1.bid;
    } else {
      // Нет арбитража
      return;
    }

    // Вычисляем спред в процентах
    const spreadPercent = ((sellPrice - buyPrice) / buyPrice) * 100;

    // Проверяем минимальный спред
    if (spreadPercent < this.config.arbitrage.minSpreadPercent) {
      return;
    }

    // Вычитаем комиссии и slippage
    const buyFee = this.config.fees[buyExchange].taker / 100; // В процентах -> в доли
    const sellFee = this.config.fees[sellExchange].taker / 100;
    const slippage = this.config.slippage.percent / 100; // В процентах -> в доли

    // Учитываем комиссии и slippage: при покупке цена выше, при продаже - ниже
    const buyPriceWithFeeAndSlippage = buyPrice * (1 + buyFee + slippage);
    const sellPriceWithFeeAndSlippage = sellPrice * (1 - sellFee - slippage);

    const profitPercent = ((sellPriceWithFeeAndSlippage - buyPriceWithFeeAndSlippage) / buyPriceWithFeeAndSlippage) * 100;

    // Создаем объект возможности
    const opportunity: ArbitrageOpportunity = {
      symbol,
      buyExchange,
      sellExchange,
      buyPrice,
      sellPrice,
      spreadPercent,
      profitPercent,
      timestamp: Date.now(),
    };

    this.opportunitiesFound++;


    // Логирование арбитражных возможностей отключено - используем только CompactLogger
    // при открытии/пропуске позиций для избежания избыточных логов

    // Умное управление позициями
    if (this.config.trading.enabled) {
      this.handleNewOpportunity(opportunity);
    }

    // Обновляем спред для открытых позиций
    this.tradeExecutor.updatePositionSpread(symbol, buyPrice, sellPrice);
  }

  /**
   * Обработать новую арбитражную возможность с умным управлением позициями
   */
  private handleNewOpportunity(
    opportunity: ArbitrageOpportunity
  ): void {
    // Проверяем, нет ли уже открытой позиции по этому символу
    const openPositions = this.tradeExecutor.getOpenPositions();
    for (const [_, pair] of openPositions.entries()) {
      if (pair.symbol === opportunity.symbol) {
        // Уже есть открытая позиция по этому символу - пропускаем
        return;
      }
    }

    // Если есть свободные слоты, просто открываем
    if (this.tradeExecutor.canOpenNewPosition()) {
      this.tradeExecutor.openPositionPair(opportunity);
      return;
    }

    // Если нет свободных слотов и включено умное закрытие
    if (this.config.trading.closeOnNewOpportunity) {
      // Проверяем каждую открытую позицию
      for (const [pairId, pair] of openPositions.entries()) {
        // Получаем текущие рыночные цены для ОТКРЫТОЙ позиции
        const currentPositionPrices = this.getCurrentPrices(pair.symbol);

        if (!currentPositionPrices) {
          this.logger.warn(`Не удалось получить текущие цены для ${pair.symbol}, пропускаем проверку`);
          continue;
        }

        // Вычисляем текущую прибыль ОТКРЫТОЙ позиции с учетом комиссий и slippage
        // Определяем биржи
        const longExchange = pair.longPosition.exchange;
        const shortExchange = pair.shortPosition.exchange;

        // Получаем комиссии
        const longFee = this.config.fees[longExchange].taker / 100;
        const shortFee = this.config.fees[shortExchange].taker / 100;
        const slippage = this.config.slippage.percent / 100;

        // LONG P&L: купили по entryPrice, продаем по currentBuyPrice
        // Учитываем комиссии при входе и выходе
        const longEntryPrice = pair.longPosition.entryPrice * (1 + longFee + slippage);
        const longExitPrice = currentPositionPrices.buyPrice * (1 - longFee - slippage);
        const longPnlPercent = ((longExitPrice - longEntryPrice) / longEntryPrice) * 100;

        // SHORT P&L: продали по entryPrice, выкупаем по currentSellPrice
        // Учитываем комиссии при входе и выходе
        const shortEntryPrice = pair.shortPosition.entryPrice * (1 - shortFee - slippage);
        const shortExitPrice = currentPositionPrices.sellPrice * (1 + shortFee + slippage);
        const shortPnlPercent = ((shortEntryPrice - shortExitPrice) / shortEntryPrice) * 100;

        // Средняя прибыль (это и есть реальная прибыль арбитража)
        const avgPnl = (longPnlPercent + shortPnlPercent) / 2;

        // Если текущая позиция прибыльна И выше порога minSpreadToNotify
        if (avgPnl >= this.config.notifications.minSpreadToNotify) {
          // И новая возможность более прибыльна
          if (opportunity.profitPercent > avgPnl) {
            this.logger.info(
              `Закрываем текущую позицию ${pair.symbol} (прибыль ${formatPercent(avgPnl)}%) для входа в более выгодную ${opportunity.symbol} (${opportunity.profitPercent.toFixed(2)}%)`
            );

            // Закрываем текущую позицию по текущим рыночным ценам
            this.tradeExecutor.closePositionManually(pairId, currentPositionPrices.buyPrice, currentPositionPrices.sellPrice);

            // Открываем новую позицию
            this.tradeExecutor.openPositionPair(opportunity);
            return;
          }
        } else {
          // Текущая позиция не прибыльна достаточно - пропускаем новую возможность
          this.logger.info(
            `Пропускаем возможность ${opportunity.symbol} - текущая позиция ${pair.symbol} имеет прибыль ${formatPercent(avgPnl)}% (ниже порога ${this.config.notifications.minSpreadToNotify}%)`
          );

          // Записываем как пропущенную
          this.tradeExecutor.recordSkippedOpportunity(
            opportunity,
            'POSITION_NOT_PROFITABLE',
            undefined,
            undefined,
            avgPnl
          );
          return;
        }
      }
    }

    // Если не смогли закрыть ни одну позицию - записываем как нехватка слотов
    this.tradeExecutor.recordSkippedOpportunity(opportunity, 'NO_FREE_SLOTS');
  }  /**
   * Получить текущие цены для символа (используется при закрытии по таймауту)
   */
  getCurrentPrices(symbol: string): { buyPrice: number; sellPrice: number } | null {
    const binancePrice = this.binance.getPrice(symbol);
    const mexcPrice = this.mexc.getPrice(MexcFutures.toMexcFormat(symbol));

    if (!binancePrice || !mexcPrice) {
      return null;
    }

    // Определяем где дешевле покупать, где дороже продавать
    let buyPrice: number;
    let sellPrice: number;

    if (binancePrice.ask < mexcPrice.bid) {
      buyPrice = binancePrice.ask;
      sellPrice = mexcPrice.bid;
    } else {
      buyPrice = mexcPrice.ask;
      sellPrice = binancePrice.bid;
    }

    return { buyPrice, sellPrice };
  }


  /**
   * Запустить минутные сводки
   */
  private startMinuteSummary(): void {
    const compactLogger = this.tradeExecutor.getCompactLogger();

    // Функция вывода сводки
    const printSummary = () => {
      const openPositions = this.tradeExecutor.getOpenPositions();
      compactLogger.printMinuteSummary(
        openPositions,
        (symbol: string) => this.getCurrentPrices(symbol)
      );
    };

    // Запускаем интервал минутных сводок
    setInterval(printSummary, 60000); // Каждую минуту

    // Первая сводка через 30 секунд после старта
    setTimeout(printSummary, 30000);

    this.logger.info('Минутные сводки активированы (первая через 30 сек, затем каждые 60 сек)');
  }

  /**
   * Остановить мониторинг
   */
  async stop(): Promise<void> {
    this.logger.info('Остановка арбитражного бота...');
    this.binance.disconnect();
    this.mexc.disconnect();
    this.tradeExecutor.stop();

    // Выводим статистику
    this.logger.separator();
    this.logger.info('📊 Статистика сессии:');
    this.logger.info(`  • Проверено пар: ${this.totalComparisons}`);
    this.logger.info(`  • Найдено возможностей: ${this.opportunitiesFound}`);
    this.logger.separator();

    // Генерируем Excel отчет
    if (this.config.trading.enabled) {
      try {
        this.logger.info('Генерация Excel отчета...');

        const stats = this.tradeExecutor.getStats();
        const skippedOpportunities = this.tradeExecutor.getSkippedOpportunities();
        const initialBalance = this.tradeExecutor.getInitialBalance();
        const currentBalance = this.tradeExecutor.getCurrentBalance();
        const closedPositions = this.tradeExecutor.getClosedPositions();
        const wsDowntimes = this.wsMonitor.getDowntimes();
        const sessionEndTime = Date.now();

        const filename = await this.excelReporter.generateReport(
          closedPositions,
          stats,
          wsDowntimes,
          skippedOpportunities,
          initialBalance,
          currentBalance,
          this.sessionStartTime,
          sessionEndTime
        );

        // Выводим статистику WebSocket
        const wsStats = this.wsMonitor.getStats();
        this.logger.separator();
        this.logger.info('🌐 WebSocket статистика:');
        this.logger.info(`  • Всего отключений: ${wsStats.totalDisconnects}`);
        this.logger.info(
          `  • Binance отключений: ${wsStats.binance.disconnects} (downtime: ${wsStats.binance.totalDowntimeMinutes} мин)`
        );
        this.logger.info(
          `  • MEXC отключений: ${wsStats.mexc.disconnects} (downtime: ${wsStats.mexc.totalDowntimeMinutes} мин)`
        );
        this.logger.info(
          `  • Общее downtime: ${wsStats.totalDowntimeMinutes} мин`
        );
        this.logger.separator();

        this.logger.success(`📄 Excel отчет сохранен: ${filename}`);
      } catch (error) {
        this.logger.error(
          `Ошибка генерации отчета: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    this.logger.success('Бот остановлен');
  }

  /**
   * Получить статистику
   */
  getStats() {
    return {
      opportunitiesFound: this.opportunitiesFound,
      totalComparisons: this.totalComparisons,
      commonSymbols: this.commonSymbols.length,
    };
  }
}

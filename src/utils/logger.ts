/**
 * Утилиты для красивого вывода в консоль
 */

export class Logger {
  private useColors: boolean;

  constructor(useColors = true) {
    this.useColors = useColors;
  }

  /**
   * ANSI цветовые коды
   */
  private colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    gray: '\x1b[90m',
    bold: '\x1b[1m',
  };

  /**
   * Применить цвет к тексту
   */
  private colorize(text: string, color: keyof typeof this.colors): string {
    if (!this.useColors) return text;
    return `${this.colors[color]}${text}${this.colors.reset}`;
  }

  /**
   * Логирование успеха (зеленый)
   */
  success(message: string): void {
    console.log(this.colorize(`✓ ${message}`, 'green'));
  }

  /**
   * Логирование ошибки (красный)
   */
  error(message: string): void {
    console.error(this.colorize(`✗ ${message}`, 'red'));
  }

  /**
   * Логирование предупреждения (желтый)
   */
  warn(message: string): void {
    console.warn(this.colorize(`⚠ ${message}`, 'yellow'));
  }

  /**
   * Логирование информации (синий)
   */
  info(message: string): void {
    console.log(this.colorize(`ℹ ${message}`, 'blue'));
  }

  /**
   * Логирование арбитражной возможности
   */
  arbitrage(data: {
    symbol: string;
    buyExchange: string;
    sellExchange: string;
    buyPrice: number;
    sellPrice: number;
    spreadPercent: number;
    profitPercent: number;
    timestamp?: number;
  }): void {
    const timestamp = data.timestamp
      ? new Date(data.timestamp).toLocaleTimeString('ru-RU')
      : new Date().toLocaleTimeString('ru-RU');

    const spread = this.colorize(
      `${data.spreadPercent.toFixed(2)}%`,
      data.spreadPercent >= 1 ? 'green' : 'yellow'
    );

    const profit = this.colorize(
      `${data.profitPercent.toFixed(2)}%`,
      data.profitPercent > 0 ? 'green' : 'red'
    );

    console.log(
      `${this.colorize(timestamp, 'gray')} | ` +
        `${this.colorize(data.symbol, 'cyan')} | ` +
        `Купить: ${this.colorize(data.buyExchange, 'blue')} @ ${data.buyPrice.toFixed(4)} | ` +
        `Продать: ${this.colorize(data.sellExchange, 'magenta')} @ ${data.sellPrice.toFixed(4)} | ` +
        `Спред: ${spread} | ` +
        `Прибыль: ${profit}`
    );
  }

  /**
   * Вывести разделитель
   */
  separator(char = '─', length = 80): void {
    console.log(char.repeat(length));
  }

  /**
   * Вывести заголовок
   */
  header(text: string): void {
    this.separator('═');
    console.log(this.colorize(text, 'bold'));
    this.separator('═');
  }
}

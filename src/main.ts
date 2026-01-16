import { ConfigLoader } from './utils/config-loader.js';
import { Logger } from './utils/logger.js';
import { ArbitrageDetector } from './arbitrage-detector.js';

/**
 * Главная функция приложения
 */
async function main() {
  const logger = new Logger();

  try {
    // Загружаем конфигурацию
    logger.info('Загрузка конфигурации...');
    const configLoader = new ConfigLoader();

    // Валидируем конфиг
    configLoader.validate();

    // Выводим краткую информацию о конфиге
    configLoader.printSummary();

    const config = configLoader.getConfig();

    // Создаем детектор арбитража
    const detector = new ArbitrageDetector(config, logger);

    // Запускаем мониторинг
    await detector.start();

    // Обработка graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n'); // Новая строка после ^C
      logger.warn('Получен сигнал SIGINT (Ctrl+C)');
      await detector.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.warn('Получен сигнал SIGTERM');
      await detector.stop();
      process.exit(0);
    });
  } catch (error) {
    logger.error(
      `Критическая ошибка: ${error instanceof Error ? error.message : String(error)}`
    );
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Запускаем приложение
main();
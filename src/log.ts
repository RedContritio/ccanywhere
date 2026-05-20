import { pino } from 'pino';

const isDev = process.env['NODE_ENV'] !== 'production';

export const logger = pino(
  isDev
    ? {
        level: process.env['LOG_LEVEL'] ?? 'debug',
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }
    : {
        level: process.env['LOG_LEVEL'] ?? 'info',
      },
);

export type Logger = typeof logger;

/**
 * Structured application logger (pino).
 *
 * Credentials, cookies and tokens are redacted at the serializer level so a
 * careless `logger.info({ req })` can never write a secret to disk.
 */
import { pino, type LoggerOptions } from 'pino';
import { env, isProduction } from '../config/env.js';
import { captureLog } from './logBuffer.js';

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.currentPassword',
  '*.newPassword',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
];

const options: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: { service: `${env.APP_SLUG}-api`, env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
  formatters: {
    level: (label) => ({ level: label }),
  },
  hooks: {
    // Keep the latest warnings/errors in memory for the admin console.
    logMethod(args, method, level) {
      if (level >= 40) captureLog(level, args);
      method.apply(this, args);
    },
  },
};

export const logger = isProduction
  ? pino(options)
  : pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          // Request/response details are already in the message line.
          ignore: 'pid,hostname,service,env,req,res,reqId,responseTime,httpErr',
          singleLine: true,
        },
      },
    });

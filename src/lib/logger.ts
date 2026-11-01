import { pino } from 'pino';
import { env, isProduction } from '../config/env.ts';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
  ...(isProduction ? {} : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
});

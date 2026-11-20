/**
 * Express application factory.
 *
 * Middleware order matters:
 *   1. request id + structured access log
 *   2. security headers, CORS
 *   3. global rate limit
 *   4. size-capped body + cookie parsing
 *   5. routes
 *   6. 404 → centralised error handler
 */
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { paystackWebhook } from './controllers/token.controller.js';
import { activityLog } from './middleware/activityLog.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { globalLimiter, userLimiter } from './middleware/rateLimit.js';
import { corsPolicy, securityHeaders } from './middleware/security.js';
import { apiRouter, healthRouter } from './routes/index.js';
import { newId } from './utils/crypto.js';
import { logger } from './utils/logger.js';
import { readRelayToken, relayUpload } from './services/storage.service.js';

const REQUEST_ID = /^[A-Za-z0-9\-_]{8,64}$/;

/** Path without the query string; Express routers rewrite req.url, so prefer originalUrl. */
function requestPath(req: { url?: string; originalUrl?: string }): string {
  return (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
}

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.set('etag', false);

  app.use(
    pinoHttp({
      logger,
      // Honour an upstream request id only if it is well-formed.
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : newId();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
      // One short line in, one short line out: "--> GET /api/v1/me" / "<-- 200 GET /api/v1/me 12ms".
      // ASCII arrows: Windows consoles without UTF-8 garble "→". Query strings
      // are dropped so tokens in links never reach the log.
      customReceivedMessage: (req) => `--> ${req.method} ${requestPath(req)}`,
      customSuccessMessage: (req, res, ms) => `<-- ${res.statusCode} ${req.method} ${requestPath(req)} ${Math.round(ms)}ms`,
      customErrorMessage: (req, res) => `<-- ${res.statusCode} ${req.method} ${requestPath(req)}`,
      // pino-http invents an Error("failed with status code 500") for every 5xx;
      // the real error is already logged by errorHandler, so park it out of sight.
      customAttributeKeys: { err: 'httpErr' },
      serializers: {
        req: (req: { id: string; method: string; url: string; remoteAddress?: string }) => ({
          id: req.id,
          method: req.method,
          path: req.url.split('?')[0],
          ip: req.remoteAddress,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(securityHeaders);
  app.use(corsPolicy);
  app.use('/health', healthRouter);

  // Upload relay: browsers PUT files here (signed link = the permission) and the
  // API streams them into R2, so the bucket needs no CORS rule. Before the rate
  // limiter (a large video is many part requests) and the JSON parser (raw stream).
  app.put('/api/v1/uploads/:token', (req, res, next) => {
    const length = req.headers['content-length'] ? Number(req.headers['content-length']) : undefined;
    void (async () => {
      const grant = readRelayToken(String(req.params.token));
      const etag = await relayUpload(grant, req, req.headers['content-type'], Number.isFinite(length) ? length : undefined);
      res.setHeader('ETag', etag);
      res.json({ ok: true, etag });
    })().catch(next);
  });

  app.use(globalLimiter, userLimiter);
  // Paystack signs the exact request bytes, so this route needs the raw body
  // and must be registered before the JSON parser.
  app.post('/api/v1/payments/paystack/webhook', express.raw({ type: 'application/json', limit: '1mb' }), paystackWebhook);
  app.use(express.json({ limit: '100kb', strict: true }));
  app.use(cookieParser());

  app.use('/api/v1', activityLog, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}



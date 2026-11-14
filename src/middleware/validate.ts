/**
 * Zod request validation.
 *
 * `body` is replaced with the parsed (sanitised, defaulted) value. Express 5
 * makes `req.query` read-only, so parsed `query` and `params` are exposed via
 * `res.locals` and read back with the typed accessors below.
 */
import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';

interface Schemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

export function validate(schemas: Schemas) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // A ZodError thrown here is turned into a 400 by the error handler.
    if (schemas.body) {
      req.body = schemas.body.parse(req.body ?? {});
    }
    if (schemas.query) {
      res.locals['query'] = schemas.query.parse(req.query);
    }
    if (schemas.params) {
      res.locals['params'] = schemas.params.parse(req.params);
    }
    next();
  };
}

/** The validated body. Only call behind `validate({ body: schema })`. */
export function validBody<S extends z.ZodType>(req: Request, _schema: S): z.output<S> {
  return req.body as z.output<S>;
}

/** The validated query. Only call behind `validate({ query: schema })`. */
export function validQuery<S extends z.ZodType>(res: Response, _schema: S): z.output<S> {
  return res.locals['query'] as z.output<S>;
}

/** The validated route params. Only call behind `validate({ params: schema })`. */
export function validParams<S extends z.ZodType>(res: Response, _schema: S): z.output<S> {
  return res.locals['params'] as z.output<S>;
}

import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';

/** doc00 §0.6: malformed body / missing required field -> 400 { error }. */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: result.error.message });
      return;
    }
    req.body = result.data;
    next();
  };
}

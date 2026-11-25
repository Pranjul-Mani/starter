import type { Request, RequestHandler, Response } from 'express';

export const field = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export function route(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => { handler(req, res).catch(next); };
}

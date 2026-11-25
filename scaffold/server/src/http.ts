import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';

export const field = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export function route(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => { handler(req, res).catch(next); };
}

export function validWebhook(signature: string | undefined, raw: Buffer, secret: string) {
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/i.exec(signature ?? '');
  if (!match || Math.abs(Math.floor(Date.now() / 1000) - Number(match[1])) > 300) return false;
  const expected = createHmac('sha256', secret).update(match[1] + '.').update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(match[2], 'hex'));
}

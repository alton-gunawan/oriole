import { Environment, Paddle } from '@paddle/paddle-node-sdk';

import { env } from '../lib/env.ts';

/** Paddle Billing SDK — Merchant of Record untuk subscription. */
export const paddle = new Paddle(env.PADDLE_API_KEY, {
  environment:
    env.PADDLE_ENV === 'production' ? Environment.production : Environment.sandbox,
});

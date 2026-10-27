// Plans and Stripe subscription billing.
// Without STRIPE_SECRET_KEY + STRIPE_PRICE_ID the app runs in demo mode:
// billing is off and every account gets Pro features.
import Stripe from 'stripe';
import { getDb, now } from './db.js';

export const PLANS = {
  free: {
    name: 'Free',
    auditsPerMonth: 3,
    features: ['3 audits per month', 'SEO, AEO & GEO scores', 'All 52 technical checks', 'Top keyword discovery', 'Rules-based summary'],
  },
  pro: {
    name: 'Pro',
    auditsPerMonth: 200,
    features: ['Unlimited* audits & score history', 'AI senior expert review', 'AI strategist chat', 'Fix pack + one-line live install', 'WordPress auto-publishing', 'AI keyword articles', 'Before/after verification'],
  },
};

export const PRO_FEATURES = new Set(['ai-review', 'strategist', 'fixes', 'deploy', 'articles']);

export const billingEnabled = () => Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);

let stripe;
const getStripe = () => (stripe ??= new Stripe(process.env.STRIPE_SECRET_KEY));

export function effectivePlan(user) {
  if (!billingEnabled()) return 'pro';
  return user?.plan === 'pro' && ['active', 'trialing', 'past_due'].includes(user.plan_status) ? 'pro' : 'free';
}

export function auditsThisMonth(userId) {
  const d = new Date();
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return getDb().prepare('SELECT COUNT(*) AS n FROM audits WHERE user_id = ? AND created_at >= ?').get(userId, start).n;
}

export function usage(user) {
  const plan = effectivePlan(user);
  return { plan, billing: billingEnabled(), used: auditsThisMonth(user.id), limit: PLANS[plan].auditsPerMonth, plans: PLANS, price: process.env.PRO_PRICE_LABEL || '$49/month' };
}

/** Express middleware: block a Pro feature for Free users with an upgrade prompt. */
export const requirePro = (feature) => (req, res, next) => {
  if (effectivePlan(req.user) === 'pro') return next();
  res.status(402).json({ error: `Upgrade to Pro to unlock ${feature}.`, code: 'upgrade' });
};

export async function createCheckout(user, baseUrl) {
  const s = getStripe();
  let customer = user.stripe_customer_id;
  if (!customer) {
    customer = (await s.customers.create({ email: user.email, name: user.name || undefined, metadata: { userId: user.id } })).id;
    getDb().prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customer, user.id);
  }
  const session = await s.checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: user.id,
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${baseUrl}/#/billing?status=success`,
    cancel_url: `${baseUrl}/#/billing?status=cancelled`,
  });
  return session.url;
}

export async function createPortal(user, baseUrl) {
  if (!user.stripe_customer_id) throw new Error('No billing account yet.');
  const session = await getStripe().billingPortal.sessions.create({ customer: user.stripe_customer_id, return_url: `${baseUrl}/#/billing` });
  return session.url;
}

function applySubscription(sub) {
  const db = getDb();
  const status = sub.status;
  const plan = ['active', 'trialing', 'past_due'].includes(status) ? 'pro' : 'free';
  db.prepare('UPDATE users SET plan = ?, plan_status = ?, stripe_subscription_id = ? WHERE stripe_customer_id = ?').run(plan, status, sub.id, sub.customer);
}

/** Verifies and applies a Stripe webhook. `rawBody` must be the unparsed request body. */
export async function handleWebhook(rawBody, signature) {
  const event = getStripe().webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  const obj = event.data.object;
  if (event.type === 'checkout.session.completed' && obj.mode === 'subscription') {
    const db = getDb();
    if (obj.client_reference_id) db.prepare('UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = ?').run(obj.customer, obj.client_reference_id);
    const sub = typeof obj.subscription === 'string' ? await getStripe().subscriptions.retrieve(obj.subscription) : obj.subscription;
    if (sub) applySubscription(sub);
  } else if (event.type.startsWith('customer.subscription.')) {
    applySubscription(obj);
  }
  return { type: event.type, handledAt: now() };
}

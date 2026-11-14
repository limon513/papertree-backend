import { Router } from 'express';
import { count, desc, eq } from 'drizzle-orm';
import { db } from '../../../db/client.ts';
import { messageLog } from '../../../db/schema/index.ts';
import { audit } from '../../../lib/audit.ts';
import { badRequest } from '../../../lib/errors.ts';
import { normalizePhone, isBdPhone } from '../../../lib/phone.ts';
import { canKeepSecrets } from '../../../lib/secrets.ts';
import { currentAdmin } from '../../../middleware/admin-auth.ts';
import { integrationBody, integrationKeyParam, messageListQuery, testBody } from './schemas.ts';
import { allIntegrationViews, integrationView, saveIntegration, sendEmail, sendSms, smsBalance } from './service.ts';
import { steadfastBalance } from '../orders/steadfast.ts';

/** Outside services (email, SMS, Google sign-in, payment). Mounted behind requireAdmin + requireSuperAdmin. */
export const integrationsRouter = Router();

const PAGE_SIZE = 50;

integrationsRouter.get('/', async (_req, res) => {
  res.json({ canKeepSecrets: canKeepSecrets(), items: await allIntegrationViews() });
});

integrationsRouter.get('/messages', async (req, res) => {
  const q = messageListQuery.parse(req.query);
  const where = q.channel === 'all' ? undefined : eq(messageLog.channel, q.channel);
  const [items, totals] = await Promise.all([
    db.select().from(messageLog).where(where).orderBy(desc(messageLog.createdAt), desc(messageLog.id)).limit(PAGE_SIZE).offset((q.page - 1) * PAGE_SIZE),
    db.select({ n: count() }).from(messageLog).where(where),
  ]);
  res.json({ items, total: totals[0]?.n ?? 0, page: q.page, pageSize: PAGE_SIZE });
});

integrationsRouter.put('/:key', async (req, res) => {
  const { key } = integrationKeyParam.parse(req.params);
  const input = integrationBody.parse(req.body);
  const changed = await saveIntegration(key, input.settings, input.secrets, currentAdmin(req).id);
  // Only which fields changed, never their values.
  await audit(req, { action: 'integration.update', entityType: 'integration', entityId: key, after: { changed } });
  res.json(await integrationView(key));
});

/** Money on the Steadfast account. Free: it only reads, so it is the safe way to check the keys. */
integrationsRouter.post('/steadfast/balance', async (_req, res) => {
  res.json(await steadfastBalance());
});

/** SMS left on the account (MiMSMS). Free: nothing is sent, so it is the safe way to check the connection. */
integrationsRouter.post('/sms/balance', async (_req, res) => {
  res.json(await smsBalance());
});

integrationsRouter.post('/:key/test', async (req, res) => {
  const { key } = integrationKeyParam.parse(req.params);
  const { to } = testBody.parse(req.body);
  if (key === 'email') {
    const row = await sendEmail({
      to,
      subject: 'PaperTree test email',
      html: '<p>This is a test from your PaperTree admin. If you can read this, email is working.</p>',
      text: 'This is a test from your PaperTree admin. If you can read this, email is working.',
      purpose: 'test',
    });
    res.json(row);
    return;
  }
  if (key === 'sms') {
    const phone = normalizePhone(to);
    if (!isBdPhone(phone)) throw badRequest('Enter a Bangladeshi number', { to: 'Enter a Bangladeshi number, like 01712345678' });
    res.json(await sendSms({ to: phone, text: 'PaperTree test SMS: if you can read this, SMS is working.', purpose: 'test' }));
    return;
  }
  throw badRequest('Only email and SMS can be tested here');
});

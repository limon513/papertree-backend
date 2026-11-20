import { env } from '../../config/env.ts';
import { getIntegration, sendEmail } from '../admin/integrations/service.ts';
import { getSettings } from '../admin/settings/service.ts';
import { esc } from './order-emails.ts';

const WAYS: Record<string, string> = {
  wholesale: 'Supply us at wholesale price',
  brand: 'We list their products and order from them per sale',
  unsure: 'Not sure yet',
};

/** Tells the shop about a new "Sell with us" lead (Integrations → Email → staff address). Never throws. */
export async function supplierLeadAlert(
  id: number,
  lead: { businessName: string; contactName: string; phone: string; email: string | null; location: string | null; products: string; ways: string[]; link: string | null; message: string | null },
) {
  try {
    const [{ settings }, store] = await Promise.all([getIntegration('email'), getSettings('store')]);
    if (!settings.staffEmail) return;
    const rows: [string, string | null][] = [
      ['Business', lead.businessName],
      ['Contact', lead.contactName],
      ['Phone', lead.phone],
      ['Email', lead.email],
      ['Location', lead.location],
      ['What they sell', lead.products],
      ['How they want to work', lead.ways.map((w) => WAYS[w] ?? w).join('; ') || null],
      ['Website / page', lead.link],
      ['Message', lead.message],
    ];
    const shown = rows.filter((r): r is [string, string] => !!r[1]);
    const admin = `${env.ADMIN_APP_URL.replace(/\/$/, '')}/leads?tab=suppliers`;
    const html = `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#18181b;background:#f4f4f5;padding:24px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:24px">
<h1 style="margin:0 0 4px;font-size:20px">New “Sell with us” lead</h1>
<p style="margin:0 0 16px;color:#52525b">${esc(lead.businessName)} wants to sell through ${esc(store.name)}.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px">${shown
      .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#71717a;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0">${esc(v).replace(/\n/g, '<br>')}</td></tr>`)
      .join('')}</table>
<p style="margin:20px 0 0"><a href="${esc(admin)}" style="display:inline-block;background:#1d5b2c;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:999px">Open in the admin</a></p>
</div></body></html>`;
    const text = [`New "Sell with us" lead`, '', ...shown.map(([k, v]) => `${k}: ${v}`), '', admin].join('\n');
    await sendEmail({ to: settings.staffEmail, subject: `Sell with us: ${lead.businessName}`, html, text, purpose: `supplier.lead #${id}` });
  } catch {
    // The lead is saved; the email is only a heads-up.
  }
}

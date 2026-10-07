/**
 * Scheduled missing-report detection (EventBridge Scheduler, hourly).
 * Daily sources: yesterday's business date (property-local) must be loaded by
 * the source's local deadline. Monthly sources: last month's actuals by the
 * configured day. Alerts are de-duplicated and notify ingestion managers once.
 */
import { addDays, localToday } from '@hop/core';
import { serviceClient } from '../supabase.js';

interface Source {
  id: string;
  company_id: string;
  name: string;
  report_type: string;
  expected_cadence: 'daily' | 'monthly' | 'none';
  expected_by_local: string | null;
  expected_by_day: number | null;
}

function localTime(tz: string, now: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
}

export async function checkMissingReports(now = new Date()): Promise<{ created: number; resolved: number }> {
  const svc = await serviceClient();
  const { data: sources } = await svc
    .from('ingestion_sources')
    .select('id, company_id, name, report_type, expected_cadence, expected_by_local, expected_by_day')
    .eq('active', true)
    .neq('expected_cadence', 'none');
  let created = 0;
  let resolved = 0;
  for (const s of (sources ?? []) as Source[]) {
    const { data: maps } = await svc.from('ingestion_property_mappings').select('property_id').eq('source_id', s.id);
    let propertyIds = ((maps ?? []) as Array<{ property_id: string }>).map((m) => m.property_id);
    const { data: props } = await svc.from('properties').select('id, code, timezone, status').eq('company_id', s.company_id);
    const all = (props ?? []) as Array<{ id: string; code: string; timezone: string; status: string }>;
    if (propertyIds.length === 0) propertyIds = all.filter((p) => p.status === 'active').map((p) => p.id);

    for (const p of all.filter((x) => propertyIds.includes(x.id))) {
      let expectedFor: string | null = null;
      let missing = false;
      const today = localToday(p.timezone, now);
      if (s.expected_cadence === 'daily' && s.report_type === 'daily_performance') {
        if (localTime(p.timezone, now) < (s.expected_by_local ?? '11:00').slice(0, 5)) continue;
        expectedFor = addDays(today, -1);
        const { count } = await svc.from('daily_performance').select('id', { count: 'exact', head: true }).eq('property_id', p.id).eq('business_date', expectedFor);
        missing = (count ?? 0) === 0;
      } else if (s.expected_cadence === 'monthly' && s.report_type === 'monthly_actuals') {
        if (Number(today.slice(8, 10)) < (s.expected_by_day ?? 15)) continue;
        const [y, m] = today.split('-').map(Number) as [number, number];
        const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
        expectedFor = prev;
        const { count } = await svc.from('financial_reports').select('id', { count: 'exact', head: true }).eq('property_id', p.id).eq('period_month', prev);
        missing = (count ?? 0) === 0;
      }
      if (!expectedFor) continue;
      if (missing) {
        const { data: inserted } = await svc
          .from('ingestion_alerts')
          .upsert(
            {
              company_id: s.company_id,
              source_id: s.id,
              property_id: p.id,
              alert_type: 'missing_report',
              expected_for: expectedFor,
              message: `${s.name}: no ${s.report_type === 'daily_performance' ? 'daily report' : 'monthly actuals'} for ${p.code} (${expectedFor})`,
            },
            { onConflict: 'source_id,property_id,alert_type,expected_for', ignoreDuplicates: true },
          )
          .select('id');
        if (inserted && inserted.length > 0) {
          created++;
          await notifyManagers(s.company_id, p.id, `Missing report: ${p.code} ${expectedFor}`);
        }
      } else {
        const { data: res } = await svc
          .from('ingestion_alerts')
          .update({ status: 'resolved', resolved_at: now.toISOString() })
          .eq('source_id', s.id)
          .eq('property_id', p.id)
          .eq('expected_for', expectedFor)
          .eq('status', 'open')
          .select('id');
        resolved += res?.length ?? 0;
      }
    }
  }
  return { created, resolved };
}

async function notifyManagers(companyId: string, propertyId: string, title: string) {
  const svc = await serviceClient();
  const { data: members } = await svc.from('company_memberships').select('user_id').eq('company_id', companyId).eq('status', 'active');
  for (const m of (members ?? []) as Array<{ user_id: string }>) {
    const { data: ok } = await svc.rpc('svc_user_has_permission', { p_user: m.user_id, p_perm: 'ingestion.view', p_company_id: companyId, p_property_id: propertyId });
    if (ok) {
      await svc.from('notifications').insert({ company_id: companyId, user_id: m.user_id, property_id: propertyId, kind: 'missing_report', title, link_path: '/imports' });
    }
  }
}

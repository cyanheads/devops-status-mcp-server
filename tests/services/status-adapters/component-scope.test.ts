/**
 * @fileoverview Tests for component scoping — the rule that narrows a status page shared
 * by several products to one of them, and the indicator derived from what remains.
 * @module tests/services/status-adapters/component-scope.test
 */

import { describe, expect, it } from 'vitest';
import {
  inScopeComponentIds,
  scopeRecords,
  scopeSummary,
} from '@/services/status-adapters/component-scope.js';
import type {
  StatuspageComponent,
  StatuspageIncident,
  StatuspageSummaryResponse,
} from '@/services/statuspage/types.js';

type Status = StatuspageComponent['status'];

function component(
  id: string,
  name: string,
  status: Status = 'operational',
  extra: Partial<StatuspageComponent> = {},
): StatuspageComponent {
  return {
    id,
    name,
    status,
    group: false,
    group_id: null,
    position: 0,
    created_at: '',
    updated_at: '',
    ...extra,
  };
}

function record(
  id: string,
  componentIds: string[],
  fields: Partial<StatuspageIncident> = {},
): StatuspageIncident {
  return {
    id,
    name: `Record ${id}`,
    impact: 'minor',
    status: 'investigating',
    created_at: '2026-10-14T00:00:00Z',
    resolved_at: null,
    monitoring_at: null,
    page_id: 'p',
    incident_updates: [],
    components: componentIds.map((c) => component(c, c)),
    ...fields,
  };
}

/** A shared page: a SendGrid group with one leaf, an ungrouped SendGrid component, and a carrier group. */
function sharedPage(
  overrides: {
    sendgridStatus?: Status;
    carrierStatus?: Status;
    incidents?: StatuspageIncident[];
    maintenances?: StatuspageIncident[];
  } = {},
): StatuspageSummaryResponse {
  return {
    page: { id: 'p', name: 'Twilio', updated_at: '', url: 'https://status.twilio.com' },
    status: { indicator: 'major', description: 'Partial System Outage' },
    components: [
      component('grp-mail', 'SendGrid Mail Sending', 'operational', { group: true }),
      component('smtp', 'SMTP', overrides.sendgridStatus ?? 'operational', {
        group_id: 'grp-mail',
      }),
      component('sg-api', 'SendGrid API'),
      component('grp-carrier', 'CARRIER NETWORK', 'partial_outage', { group: true }),
      component('sms', 'SMS, Latin America', overrides.carrierStatus ?? 'partial_outage', {
        group_id: 'grp-carrier',
      }),
      component('twilio-email', 'Twilio Email SendGrid relay'),
    ],
    incidents: overrides.incidents ?? [],
    scheduled_maintenances: overrides.maintenances ?? [],
  };
}

describe('inScopeComponentIds', () => {
  it('takes a component whose own name, or whose group name, starts with the prefix', () => {
    expect([...inScopeComponentIds(sharedPage().components, 'SendGrid')].sort()).toEqual([
      'grp-mail',
      'sg-api',
      'smtp',
    ]);
  });

  it('matches the prefix at the start only, and case-sensitively', () => {
    const ids = inScopeComponentIds(
      [component('a', 'sendgrid lower'), component('b', 'Twilio Email SendGrid relay')],
      'SendGrid',
    );
    expect(ids.size).toBe(0);
  });
});

describe('scopeRecords', () => {
  it('keeps a record that touches any in-scope component and drops the rest', () => {
    const ids = new Set(['smtp']);
    const records = [
      record('a', ['smtp']),
      record('b', ['sms']),
      record('c', ['sms', 'smtp']),
      record('d', []),
    ];
    expect(scopeRecords(records, ids).map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('drops a record whose page omitted the components list', () => {
    const { components: _omit, ...bare } = record('a', ['smtp']);
    expect(scopeRecords([bare as StatuspageIncident], new Set(['smtp']))).toEqual([]);
  });
});

describe('scopeSummary', () => {
  it('names the page for the scoped vendor and keeps only its components', () => {
    const scoped = scopeSummary(sharedPage(), 'SendGrid', 'SendGrid');
    expect(scoped.page.name).toBe('SendGrid');
    expect(scoped.components.map((c) => c.id)).toEqual(['grp-mail', 'smtp', 'sg-api']);
  });

  it('ignores a degraded component outside the scope', () => {
    expect(scopeSummary(sharedPage(), 'SendGrid', 'SendGrid').status).toEqual({
      indicator: 'none',
      description: 'All Systems Operational',
    });
  });

  it.each([
    ['degraded_performance', 'minor', 'Partially Degraded Service'],
    ['partial_outage', 'major', 'Partial System Outage'],
    ['major_outage', 'critical', 'Major System Outage'],
  ] as const)('rates an in-scope %s component %s', (status, indicator, description) => {
    const scoped = scopeSummary(sharedPage({ sendgridStatus: status }), 'SendGrid', 'SendGrid');
    expect(scoped.status).toEqual({ indicator, description });
  });

  it('takes the worse of the worst open incident and the worst component', () => {
    const page = sharedPage({
      sendgridStatus: 'degraded_performance',
      incidents: [
        record('inc-crit', ['smtp'], { impact: 'critical' }),
        record('inc-carrier', ['sms'], { impact: 'critical' }),
      ],
    });
    const scoped = scopeSummary(page, 'SendGrid', 'SendGrid');
    expect(scoped.incidents?.map((i) => i.id)).toEqual(['inc-crit']);
    expect(scoped.status.indicator).toBe('critical');

    const milder = sharedPage({
      sendgridStatus: 'partial_outage',
      incidents: [record('inc-minor', ['sg-api'], { impact: 'minor' })],
    });
    expect(scopeSummary(milder, 'SendGrid', 'SendGrid').status.indicator).toBe('major');
  });

  it('does not rate a resolved incident, or one of impact none or maintenance', () => {
    const page = sharedPage({
      incidents: [
        record('done', ['smtp'], { impact: 'critical', status: 'resolved' }),
        record('pm', ['smtp'], { impact: 'major', status: 'postmortem' }),
        record('info', ['smtp'], { impact: 'none' }),
        record('window', ['smtp'], { impact: 'maintenance', status: 'scheduled' }),
      ],
    });
    expect(scopeSummary(page, 'SendGrid', 'SendGrid').status.indicator).toBe('none');
  });

  it('reads maintenance when only an in-scope window is open', () => {
    const inProgress = sharedPage({
      maintenances: [record('m1', ['sg-api'], { impact: 'maintenance', status: 'in_progress' })],
    });
    expect(scopeSummary(inProgress, 'SendGrid', 'SendGrid').status).toEqual({
      indicator: 'maintenance',
      description: 'Service Under Maintenance',
    });

    const underMaintenance = sharedPage({ sendgridStatus: 'under_maintenance' });
    expect(scopeSummary(underMaintenance, 'SendGrid', 'SendGrid').status.indicator).toBe(
      'maintenance',
    );
  });

  it('reads none for an upcoming in-scope window or an open window outside the scope', () => {
    const page = sharedPage({
      maintenances: [
        record('m-upcoming', ['smtp'], { impact: 'maintenance', status: 'scheduled' }),
        record('m-carrier', ['sms'], { impact: 'maintenance', status: 'in_progress' }),
      ],
    });
    const scoped = scopeSummary(page, 'SendGrid', 'SendGrid');
    expect(scoped.scheduled_maintenances?.map((m) => m.id)).toEqual(['m-upcoming']);
    expect(scoped.status.indicator).toBe('none');
  });

  it('lets a fault outrank an open window', () => {
    const page = sharedPage({
      sendgridStatus: 'degraded_performance',
      maintenances: [record('m1', ['sg-api'], { impact: 'maintenance', status: 'in_progress' })],
    });
    expect(scopeSummary(page, 'SendGrid', 'SendGrid').status.indicator).toBe('minor');
  });

  it('keeps an absent incidents or maintenance list absent-safe', () => {
    const { incidents: _i, scheduled_maintenances: _m, ...bare } = sharedPage();
    const scoped = scopeSummary(bare, 'SendGrid', 'SendGrid');
    expect(scoped.incidents).toEqual([]);
    expect(scoped.scheduled_maintenances).toEqual([]);
  });
});

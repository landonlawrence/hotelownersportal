import type { ReactNode } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import type { Permission } from '@hop/core';
import { usePortal, useCompany } from '../state/portal';
import { Card, Empty, Notice } from './ui';

export type SectionState = 'open' | 'locked' | 'hidden' | 'disabled';

/**
 * Whether a section is usable from the effective (per-property) permissions.
 * Company-level role permissions only count for members with access to every
 * property, so a limited grant never shows sections it doesn't cover. The
 * database enforces the same rules; this only decides what to show.
 */
export function useSectionState() {
  const { canAny, mfaLocked } = usePortal();
  const c = useCompany();
  return (perms: Permission[] | undefined, module?: string): SectionState => {
    // A module switched off for the company is not a missing permission (R3-35).
    if (module && c.modules[module] === false) return 'disabled';
    if (!perms) return 'open';
    if (perms.some((p) => canAny(p) || (c.all_properties && c.company_permissions.includes(p)))) return 'open';
    if (perms.some((p) => mfaLocked(p))) return 'locked';
    return 'hidden';
  };
}

/** Route guard: renders the section only when the user's effective permissions cover it. */
export function RequirePermission({ perms, module, section, children }: { perms: Permission[]; module?: string; section: string; children?: ReactNode }) {
  const state = useSectionState()(perms, module);
  const location = useLocation();
  const c = useCompany();
  if (state === 'open') return <>{children ?? <Outlet />}</>;
  if (state === 'disabled') {
    return (
      <Card>
        <Empty page title={`${section} isn’t enabled for ${c.company_name}`}>
          Your platform administrator can turn it on. <Link to="/">Go to the home page</Link>
        </Empty>
      </Card>
    );
  }
  if (state === 'locked') {
    return (
      <Card>
        <Empty page title={`Verify with two-factor authentication to open ${section}`}>
          <span className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
            <Link className="btn btn-primary" to={verifyLink(location.pathname + location.search)}>Verify with 2FA</Link>
          </span>
        </Empty>
      </Card>
    );
  }
  return (
    <Card>
      <Empty page title="You don’t have access to this section">
        {section} isn’t part of the access you’ve been given. <Link to="/">Go to the home page</Link>
      </Empty>
    </Card>
  );
}

/** Link to the 2FA page that comes back to `next` afterwards. */
export function verifyLink(next: string): string {
  return `/security?next=${encodeURIComponent(next)}`;
}

/**
 * Banner for pages the user can open but where some of their role's data or actions need a
 * 2FA-verified session (RLS hides those rows until then, so lists would look empty).
 */
export function MfaLockedNotice({ perms, children }: { perms: Permission[]; children?: ReactNode }) {
  const { mfaLocked } = usePortal();
  const location = useLocation();
  if (!perms.some((p) => mfaLocked(p))) return null;
  return (
    <Notice tone="warn">
      {children ?? 'Some data and actions need a 2FA-verified session.'}{' '}
      <Link to={verifyLink(location.pathname + location.search)}>Verify with 2FA</Link>
    </Notice>
  );
}

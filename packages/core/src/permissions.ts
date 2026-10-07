/**
 * Permission catalogue mirrored from the database (public.permissions).
 * The database is authoritative; the UI uses this only to hide controls.
 * An integration test asserts both lists match.
 */
export const ROLES = [
  'company_admin',
  'corporate_finance',
  'corporate_operations',
  'property_manager',
  'owner',
  'investor',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  company_admin: 'Company administrator',
  corporate_finance: 'Corporate finance',
  corporate_operations: 'Corporate operations',
  property_manager: 'Property manager',
  owner: 'Owner',
  investor: 'Investor',
};

export const CORPORATE_ROLES: Role[] = ['company_admin', 'corporate_finance', 'corporate_operations'];

export const MODULES = ['performance', 'financials', 'capex', 'documents', 'reports', 'ingestion', 'admin'] as const;
export type Module = (typeof MODULES)[number];

export const PERMISSIONS = {
  'performance.view': { module: 'performance', privileged: false },
  'financials.view': { module: 'financials', privileged: false },
  'financials.view_draft': { module: 'financials', privileged: true },
  'financials.edit': { module: 'financials', privileged: true },
  'financials.publish': { module: 'financials', privileged: true },
  'budgets.view': { module: 'financials', privileged: false },
  'budgets.edit': { module: 'financials', privileged: true },
  'budgets.approve': { module: 'financials', privileged: true },
  'documents.view': { module: 'documents', privileged: false },
  'documents.view_owner': { module: 'documents', privileged: false },
  'documents.view_internal': { module: 'documents', privileged: false },
  'documents.view_confidential': { module: 'documents', privileged: false },
  'documents.upload': { module: 'documents', privileged: false },
  'documents.manage': { module: 'documents', privileged: true },
  'capex.view': { module: 'capex', privileged: false },
  'capex.edit': { module: 'capex', privileged: false },
  'capex.approve': { module: 'capex', privileged: true },
  'reports.view': { module: 'reports', privileged: false },
  'reports.edit': { module: 'reports', privileged: true },
  'reports.publish': { module: 'reports', privileged: true },
  'commentary.view': { module: 'reports', privileged: false },
  'commentary.view_internal': { module: 'reports', privileged: false },
  'commentary.edit': { module: 'reports', privileged: false },
  'ingestion.view': { module: 'ingestion', privileged: false },
  'ingestion.manage': { module: 'ingestion', privileged: true },
  'ownership.view': { module: 'admin', privileged: false },
  'admin.users': { module: 'admin', privileged: true },
  'admin.company': { module: 'admin', privileged: true },
  'audit.view': { module: 'admin', privileged: true },
} as const satisfies Record<string, { module: Module; privileged: boolean }>;

export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];

export type DocumentVisibility = 'general' | 'owner' | 'internal' | 'confidential';

export const DOCUMENT_VISIBILITY_PERMISSION: Record<DocumentVisibility, Permission> = {
  general: 'documents.view',
  owner: 'documents.view_owner',
  internal: 'documents.view_internal',
  confidential: 'documents.view_confidential',
};

export const DOCUMENT_VISIBILITY_LABELS: Record<DocumentVisibility, string> = {
  general: 'Owners & investors',
  owner: 'Owners only',
  internal: 'Internal (management)',
  confidential: 'Confidential',
};

/** Client-side helper for UI gating. */
export class PermissionSet {
  private readonly company: Set<string>;
  private readonly byProperty: Map<string, Set<string>>;
  constructor(companyPermissions: string[], propertyPermissions: Array<{ property_id: string; permission_key: string }>) {
    this.company = new Set(companyPermissions);
    this.byProperty = new Map();
    for (const p of propertyPermissions) {
      if (!this.byProperty.has(p.property_id)) this.byProperty.set(p.property_id, new Set());
      this.byProperty.get(p.property_id)!.add(p.permission_key);
    }
  }
  has(perm: Permission, propertyId?: string): boolean {
    if (propertyId) return this.byProperty.get(propertyId)?.has(perm) ?? false;
    return this.company.has(perm);
  }
  /** True if the permission is held on at least one property. */
  any(perm: Permission): boolean {
    for (const s of this.byProperty.values()) if (s.has(perm)) return true;
    return false;
  }
  propertiesWith(perm: Permission): string[] {
    return [...this.byProperty.entries()].filter(([, s]) => s.has(perm)).map(([id]) => id);
  }
}

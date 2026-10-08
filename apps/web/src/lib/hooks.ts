import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, unwrap } from './supabase';
import type { Account } from '@hop/core';

export function useAccounts(companyId: string) {
  return useQuery({
    queryKey: ['accounts', companyId],
    queryFn: async () => unwrap(await supabase.from('financial_accounts').select('id, code, name, nature, section, sort_order').eq('company_id', companyId).eq('active', true).order('sort_order')) as Account[],
  });
}

export function useDisplayNames(ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))].sort();
  return useQuery({
    queryKey: ['names', unique.join(',')],
    enabled: unique.length > 0,
    queryFn: async () => {
      const rows = unwrap(await supabase.rpc('user_display_names', { p_user_ids: unique })) as Array<{ user_id: string; display_name: string }>;
      return new Map(rows.map((r) => [r.user_id, r.display_name]));
    },
  });
}

/** Wraps an RPC call as a mutation that refreshes all queries on success. */
export function useRpc<A extends Record<string, unknown>>(fn: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: A) => unwrap(await supabase.rpc(fn, args)),
    onSuccess: () => qc.invalidateQueries(),
  });
}

import { useCallback, useRef } from 'react';
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

/**
 * Synchronous in-flight guard for submit handlers. React state (isPending) only updates
 * after a re-render, so both clicks of a double-click would otherwise get through.
 * `guard(fn)` runs fn unless a previous run is still in flight; then it returns undefined.
 */
export function useSubmitGuard() {
  const inFlight = useRef(false);
  return useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    try {
      return await fn();
    } finally {
      inFlight.current = false;
    }
  }, []);
}

/**
 * Wraps an RPC call as a mutation that refreshes all queries on success. A second call
 * while one is in flight is ignored (its promise never settles), so a double-click
 * sends exactly one RPC.
 */
export function useRpc<A extends Record<string, unknown>>(fn: string) {
  const qc = useQueryClient();
  const inFlight = useRef(false);
  const m = useMutation({
    mutationFn: async (args: A) => unwrap(await supabase.rpc(fn, args)),
    onSuccess: () => qc.invalidateQueries(),
  });
  const { mutateAsync: rawAsync } = m;
  const mutateAsync = useCallback(
    (args: A): ReturnType<typeof rawAsync> => {
      if (inFlight.current) return new Promise<never>(() => undefined);
      inFlight.current = true;
      return rawAsync(args).finally(() => {
        inFlight.current = false;
      });
    },
    [rawAsync],
  );
  const mutate = useCallback((args: A) => void mutateAsync(args).catch(() => undefined), [mutateAsync]);
  return { ...m, mutate, mutateAsync };
}

import type { ReactNode } from 'react';
import type { ListControllerResult, RaRecord } from 'ra-core';
import { ListContextProvider } from 'ra-core';
import { ListView } from '../kit/components/admin/list.js';

const noop = () => undefined;

export function PrototypeList({
  resource,
  title,
  records,
  children,
}: {
  resource: string;
  title: string;
  records: RaRecord[];
  children: ReactNode;
}) {
  const value: ListControllerResult = {
    data: records,
    total: records.length,
    error: null,
    isPending: false,
    isFetching: false,
    isLoading: false,
    sort: { field: 'id', order: 'ASC' },
    displayedFilters: {},
    filterValues: {},
    onSelect: noop,
    onSelectAll: noop,
    onToggleItem: noop,
    onUnselectItems: noop,
    page: 1,
    perPage: records.length || 10,
    refetch: () => undefined,
    resource,
    selectedIds: [],
    setFilters: noop,
    setPage: noop,
    setPerPage: noop,
    setSort: noop,
    showFilter: noop,
    hideFilter: noop,
  };

  return (
    <ListContextProvider value={value}>
      <ListView title={title} actions={false} pagination={false}>
        {children}
      </ListView>
    </ListContextProvider>
  );
}

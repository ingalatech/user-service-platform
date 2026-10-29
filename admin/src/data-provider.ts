import type {
  DataProvider,
  GetListParams,
  GetListResult,
  GetOneParams,
  GetOneResult,
  RaRecord,
  UpdateParams,
  UpdateResult,
} from 'ra-core';
import {
  adminUserAccountDetails,
  adminUserDetail,
  adminUsers,
  updateAdminUserAccountDetails,
} from './api.js';

const unsupported = (): Promise<never> =>
  Promise.reject(new Error('Esta operación no está disponible en el panel.'));

export const dataProvider: DataProvider = {
  supportAbortSignal: true,
  getList: async <RecordType extends RaRecord>(
    resource: string,
    params: GetListParams,
  ): Promise<GetListResult<RecordType>> => {
    if (resource !== 'users') return unsupported();
    const filter: unknown = params.filter;
    const rawEmail =
      filter !== null && typeof filter === 'object' && 'email' in filter ? filter.email : undefined;
    if (rawEmail !== undefined && typeof rawEmail !== 'string') return unsupported();
    const email = rawEmail?.trim();
    const { page, perPage } = params.pagination ?? { page: 1, perPage: 25 };
    const result = await adminUsers(
      {
        limit: perPage,
        offset: (page - 1) * perPage,
        ...(email === undefined || email.length === 0 ? {} : { email }),
      },
      params.signal,
    );
    // ra-core's provider interface is generic over the consumer's record type.
    // This single-resource adapter has already parsed the application contract.
    return { data: result.items as unknown as RecordType[], total: result.total };
  },
  getOne: async <RecordType extends RaRecord>(
    resource: string,
    params: GetOneParams<RecordType>,
  ): Promise<GetOneResult<RecordType>> => {
    if (resource !== 'users') return unsupported();
    if (typeof params.id !== 'string') return unsupported();
    const [user, accountDetails] = await Promise.all([
      adminUserDetail(params.id, params.signal ?? undefined),
      adminUserAccountDetails(params.id, params.signal ?? undefined),
    ]);
    // ra-core's provider interface is generic over the consumer's record type.
    // This single-resource adapter has already parsed the application contract.
    return { data: { ...user, ...accountDetails } as unknown as RecordType };
  },
  getMany: unsupported,
  getManyReference: unsupported,
  create: unsupported,
  update: async <RecordType extends RaRecord>(
    resource: string,
    params: UpdateParams<RecordType>,
  ): Promise<UpdateResult<RecordType>> => {
    if (resource !== 'users' || typeof params.id !== 'string') return unsupported();
    const accountDetails = await updateAdminUserAccountDetails(params.id, params.data);
    return { data: { id: params.id, ...accountDetails } as unknown as RecordType };
  },
  updateMany: unsupported,
  delete: unsupported,
  deleteMany: unsupported,
};

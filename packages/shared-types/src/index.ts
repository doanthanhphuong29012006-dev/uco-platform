export enum Role {
  MERCHANT = 'MERCHANT',
  COLLECTOR = 'COLLECTOR',
  STATION = 'STATION',
  ADMIN = 'ADMIN',
}

export enum EntityStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

export enum ContainerState {
  AT_MERCHANT = 'AT_MERCHANT',
  IN_TRANSIT = 'IN_TRANSIT',
  AT_STATION = 'AT_STATION',
}

export enum OrderStatus {
  READY = 'READY',
  ASSIGNED = 'ASSIGNED',
  COLLECTED = 'COLLECTED',
  CANCELLED = 'CANCELLED',
}

export enum OrderSource {
  MANUAL = 'MANUAL',
  PREDICTED = 'PREDICTED',
}

export enum Quality {
  PASS = 'PASS',
  FLAG = 'FLAG',
}

export type UserRole = Role;
export type QualityStatus = Quality;

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
}

import { EntityStatus, type PrismaClient } from '@prisma/client';

export const demoWards = [
  {
    code: 'HB-HK-DEMO',
    name: 'Phường Hàng Bạc',
    district: 'Quận Hoàn Kiếm',
    city: 'Hà Nội',
    centerLat: 21.0333,
    centerLng: 105.85,
  },
  {
    code: 'CV-BD-DEMO',
    name: 'Phường Cống Vị',
    district: 'Quận Ba Đình',
    city: 'Hà Nội',
    centerLat: 21.0358,
    centerLng: 105.8118,
  },
  {
    code: 'NT-HBT-DEMO',
    name: 'Phường Nguyễn Du',
    district: 'Quận Hai Bà Trưng',
    city: 'Hà Nội',
    centerLat: 21.0181,
    centerLng: 105.8469,
  },
  {
    code: 'TD-DD-DEMO',
    name: 'Phường Trung Tự',
    district: 'Quận Đống Đa',
    city: 'Hà Nội',
    centerLat: 21.0104,
    centerLng: 105.8291,
  },
] as const;

export type DemoWardCode = (typeof demoWards)[number]['code'];

export async function upsertDemoWards(prisma: Pick<PrismaClient, 'ward'>) {
  const wardIdsByCode = new Map<DemoWardCode, string>();

  for (const ward of demoWards) {
    const persistedWard = await prisma.ward.upsert({
      where: { code: ward.code },
      update: {
        name: ward.name,
        district: ward.district,
        city: ward.city,
        centerLat: ward.centerLat,
        centerLng: ward.centerLng,
        status: EntityStatus.ACTIVE,
        isActive: true,
        deletedAt: null,
      },
      create: {
        ...ward,
        status: EntityStatus.ACTIVE,
        isActive: true,
      },
      select: { id: true },
    });

    wardIdsByCode.set(ward.code, persistedWard.id);
  }

  return wardIdsByCode;
}

export function getDemoWardId(
  wardIdsByCode: ReadonlyMap<DemoWardCode, string>,
  code: DemoWardCode,
) {
  const wardId = wardIdsByCode.get(code);
  if (!wardId) {
    throw new Error(`Demo Ward was not persisted: ${code}`);
  }
  return wardId;
}

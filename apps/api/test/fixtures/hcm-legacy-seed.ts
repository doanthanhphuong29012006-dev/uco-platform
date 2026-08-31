import {
  ContainerState,
  MerchantApprovalStatus,
  PriceUnit,
  PrismaClient,
  Role,
} from '@prisma/client';

// Isolated legacy HCMC fixture for integration scenarios. Production/demo seeding uses scripts/seed-demo.ts.

const prisma = new PrismaClient();

const wardId = '10000000-0000-4000-8000-000000000001';
const hanoiWardId = '10000000-0000-4000-8000-000000000002';
const stationId = '30000000-0000-4000-8000-000000000001';
const stationUserId = '40000000-0000-4000-8000-000000000001';
const hanoiCollectorId = '50000000-0000-4000-8000-000000000003';
const hanoiCollectorUserId = '40000000-0000-4000-8000-000000000203';
const hanoiStationId = '30000000-0000-4000-8000-000000000002';
const hanoiStationUserId = '40000000-0000-4000-8000-000000000002';
const initialOilPriceId = '80000000-0000-4000-8000-000000000001';

function startOfCurrentMonthInVietnam(now = new Date()): Date {
  const vietnamOffsetMs = 7 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + vietnamOffsetMs);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - vietnamOffsetMs);
}

const merchantSeeds = [
  {
    id: '20000000-0000-4000-8000-000000000001',
    userId: '40000000-0000-4000-8000-000000000101',
    zaloId: 'zalo_merchant_01',
    phone: '0900000001',
    name: 'Merchant 01',
    businessName: 'Quán Cơm Nhà Mình',
    address: '12 Nguyễn Thị Minh Khai, Phường 7, Quận 3',
    lat: 10.78255,
    lng: 106.68475,
    avgDailyLiters: 20,
    lastCollectedDaysAgo: 0,
  },
  {
    id: '20000000-0000-4000-8000-000000000002',
    userId: '40000000-0000-4000-8000-000000000102',
    zaloId: 'zalo_merchant_02',
    phone: '0900000002',
    name: 'Merchant 02',
    businessName: 'Bếp Xanh Vegetarian',
    address: '35 Võ Văn Tần, Phường 7, Quận 3',
    lat: 10.78195,
    lng: 106.68535,
    avgDailyLiters: 18,
    lastCollectedDaysAgo: 3,
  },
  {
    id: '20000000-0000-4000-8000-000000000003',
    userId: '40000000-0000-4000-8000-000000000103',
    zaloId: 'zalo_merchant_03',
    phone: '0900000003',
    name: 'Merchant 03',
    businessName: 'Phở Sài Gòn 1975',
    address: '88 Điện Biên Phủ, Phường 7, Quận 3',
    lat: 10.78305,
    lng: 106.68615,
    avgDailyLiters: 25,
    lastCollectedDaysAgo: 10,
  },
  {
    id: '20000000-0000-4000-8000-000000000004',
    userId: '40000000-0000-4000-8000-000000000104',
    zaloId: 'zalo_merchant_04',
    phone: '0900000004',
    name: 'Merchant 04',
    businessName: 'Bún Bò Huế Mạ Tôi',
    address: '21 Trần Quốc Toản, Phường 7, Quận 3',
    lat: 10.78095,
    lng: 106.68425,
    avgDailyLiters: 15,
    lastCollectedDaysAgo: 0,
  },
  {
    id: '20000000-0000-4000-8000-000000000005',
    userId: '40000000-0000-4000-8000-000000000105',
    zaloId: 'zalo_merchant_05',
    phone: '0900000005',
    name: 'Merchant 05',
    businessName: 'Cơm Tấm Góc Phố',
    address: '64 Pasteur, Phường 7, Quận 3',
    lat: 10.78155,
    lng: 106.68375,
    avgDailyLiters: 22,
    lastCollectedDaysAgo: 3,
  },
] as const;

const collectorSeeds = [
  {
    id: '50000000-0000-4000-8000-000000000001',
    userId: '40000000-0000-4000-8000-000000000201',
    zaloId: 'zalo_collector_01',
    phone: '0910000001',
    name: 'Collector 01',
    displayName: 'Nguyễn Văn Thu Gom 1',
  },
  {
    id: '50000000-0000-4000-8000-000000000002',
    userId: '40000000-0000-4000-8000-000000000202',
    zaloId: 'zalo_collector_02',
    phone: '0910000002',
    name: 'Collector 02',
    displayName: 'Trần Văn Thu Gom 2',
  },
] as const;

const containerSeeds = merchantSeeds.flatMap((merchant, merchantIndex) => {
  const count = merchantIndex < 3 ? 2 : 1;
  return Array.from({ length: count }, (_, index) => ({
    id: `60000000-0000-4000-8000-${String(merchantIndex * 2 + index + 1).padStart(12, '0')}`,
    merchantId: merchant.id,
    wardId,
    qrCode: `ECO-UCO-Q3-P7-${String(merchantIndex * 2 + index + 1).padStart(3, '0')}`,
  }));
});

async function upsertUser(input: {
  id: string;
  zaloId: string;
  phone: string;
  name: string;
  role: Role;
}): Promise<void> {
  await prisma.user.upsert({
    where: { id: input.id },
    update: {
      zaloId: input.zaloId,
      phone: input.phone,
      name: input.name,
      role: input.role,
      deletedAt: null,
    },
    create: input,
  });
}

async function setGeography(table: 'merchants' | 'stations', id: string, lat: number, lng: number): Promise<void> {
  const column = table === 'merchants' ? 'location' : 'location';
  await prisma.$executeRawUnsafe(
    `UPDATE "${table}" SET "${column}" = ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography WHERE "id" = $3::uuid`,
    lng,
    lat,
    id,
  );
}

async function main(): Promise<void> {
  await prisma.ward.upsert({
    where: { id: wardId },
    update: {
      code: 'Q3-P7',
      name: 'Phường 7, Quận 3',
      district: 'Quận 3',
      city: 'Ho Chi Minh City',
      centerLat: 10.7818,
      centerLng: 106.6851,
      deletedAt: null,
      status: 'ACTIVE',
      isActive: true,
    },
    create: {
      id: wardId,
      code: 'Q3-P7',
      name: 'Phường 7, Quận 3',
      district: 'Quận 3',
      city: 'Ho Chi Minh City',
      centerLat: 10.7818,
      centerLng: 106.6851,
    },
  });

  await prisma.ward.upsert({
    where: { id: hanoiWardId },
    update: {
      code: 'HB-HK',
      name: 'Phường Hàng Bạc',
      district: 'Quận Hoàn Kiếm',
      city: 'Hà Nội',
      centerLat: 21.0333,
      centerLng: 105.85,
      status: 'ACTIVE',
      isActive: true,
      deletedAt: null,
    },
    create: {
      id: hanoiWardId,
      code: 'HB-HK',
      name: 'Phường Hàng Bạc',
      district: 'Quận Hoàn Kiếm',
      city: 'Hà Nội',
      centerLat: 21.0333,
      centerLng: 105.85,
      status: 'ACTIVE',
      isActive: true,
    },
  });

  await upsertUser({
    id: '40000000-0000-4000-8000-000000000999',
    zaloId: 'zalo_admin_01',
    phone: '0990000001',
    name: 'Admin Eco-Oil',
    role: Role.ADMIN,
  });

  for (const merchant of merchantSeeds) {
    await upsertUser({
      id: merchant.userId,
      zaloId: merchant.zaloId,
      phone: merchant.phone,
      name: merchant.name,
      role: Role.MERCHANT,
    });
    await prisma.merchant.upsert({
      where: { id: merchant.id },
      update: {
        userId: merchant.userId,
        wardId,
        businessName: merchant.businessName,
        businessType: 'Quán ăn',
        address: merchant.address,
        avgDailyLiters: merchant.avgDailyLiters,
        lastCollectedAt: new Date(Date.now() - merchant.lastCollectedDaysAgo * 24 * 60 * 60 * 1000),
        status: 'ACTIVE',
        approvalStatus: MerchantApprovalStatus.APPROVED,
        isActive: true,
        deletedAt: null,
      },
      create: {
        id: merchant.id,
        userId: merchant.userId,
        wardId,
        businessName: merchant.businessName,
        businessType: 'Quán ăn',
        address: merchant.address,
        avgDailyLiters: merchant.avgDailyLiters,
        lastCollectedAt: new Date(Date.now() - merchant.lastCollectedDaysAgo * 24 * 60 * 60 * 1000),
        status: 'ACTIVE',
        approvalStatus: MerchantApprovalStatus.APPROVED,
      },
    });
    await setGeography('merchants', merchant.id, merchant.lat, merchant.lng);
  }

  for (const collector of collectorSeeds) {
    await upsertUser({
      id: collector.userId,
      zaloId: collector.zaloId,
      phone: collector.phone,
      name: collector.name,
      role: Role.COLLECTOR,
    });
    await prisma.collector.upsert({
      where: { id: collector.id },
      update: {
        userId: collector.userId,
        displayName: collector.displayName,
        vehicleType: 'Xe máy có thùng chứa',
        maxCapacityLiters: 100,
        status: 'ACTIVE',
        isActive: true,
        deletedAt: null,
      },
      create: {
        id: collector.id,
        userId: collector.userId,
        displayName: collector.displayName,
        vehicleType: 'Xe máy có thùng chứa',
        maxCapacityLiters: 100,
        status: 'ACTIVE',
      },
    });
    await prisma.collectorWard.upsert({
      where: { collectorId_wardId: { collectorId: collector.id, wardId } },
      update: {},
      create: { collectorId: collector.id, wardId },
    });
  }

  await upsertUser({
    id: hanoiCollectorUserId,
    zaloId: 'zalo_collector_03',
    phone: '0910000003',
    name: 'Collector 03',
    role: Role.COLLECTOR,
  });
  await prisma.collector.upsert({
    where: { id: hanoiCollectorId },
    update: {
      userId: hanoiCollectorUserId,
      displayName: 'Lê Văn Thu Gom 3',
      vehicleType: 'Xe tải nhỏ',
      maxCapacityLiters: 100,
      status: 'ACTIVE',
      isActive: true,
      deletedAt: null,
    },
    create: {
      id: hanoiCollectorId,
      userId: hanoiCollectorUserId,
      displayName: 'Lê Văn Thu Gom 3',
      vehicleType: 'Xe tải nhỏ',
      maxCapacityLiters: 100,
      status: 'ACTIVE',
    },
  });
  const optionalMolaWard = await prisma.ward.findUnique({ where: { code: 'ML-HN' }, select: { id: true } });
  for (const assignedWardId of [hanoiWardId, optionalMolaWard?.id].filter((id): id is string => Boolean(id))) {
    await prisma.collectorWard.upsert({
      where: { collectorId_wardId: { collectorId: hanoiCollectorId, wardId: assignedWardId } },
      update: {},
      create: { collectorId: hanoiCollectorId, wardId: assignedWardId },
    });
  }

  await upsertUser({
    id: stationUserId,
    zaloId: 'zalo_station_01',
    phone: '0920000001',
    name: 'Station 01',
    role: Role.STATION,
  });
  await prisma.station.upsert({
    where: { id: stationId },
    update: {
      userId: stationUserId,
      wardId,
      name: 'Trạm Eco-Oil Phường 7',
      address: '100 Cách Mạng Tháng Tám, Phường 7, Quận 3',
      capacityLiters: 1000,
      status: 'ACTIVE',
      isActive: true,
      deletedAt: null,
    },
    create: {
      id: stationId,
      userId: stationUserId,
      wardId,
      name: 'Trạm Eco-Oil Phường 7',
      address: '100 Cách Mạng Tháng Tám, Phường 7, Quận 3',
      capacityLiters: 1000,
      status: 'ACTIVE',
    },
  });
  await setGeography('stations', stationId, 10.7818, 106.6851);

  await upsertUser({
    id: hanoiStationUserId,
    zaloId: 'zalo_station_02',
    phone: '0920000002',
    name: 'Station Hà Nội',
    role: Role.STATION,
  });
  await prisma.station.upsert({
    where: { id: hanoiStationId },
    update: {
      userId: hanoiStationUserId,
      wardId: hanoiWardId,
      name: 'Trạm Eco-Oil Hàng Bạc',
      address: '12 Hàng Bạc, Hoàn Kiếm, Hà Nội',
      capacityLiters: 1000,
      status: 'ACTIVE',
      isActive: true,
      deletedAt: null,
    },
    create: {
      id: hanoiStationId,
      userId: hanoiStationUserId,
      wardId: hanoiWardId,
      name: 'Trạm Eco-Oil Hàng Bạc',
      address: '12 Hàng Bạc, Hoàn Kiếm, Hà Nội',
      capacityLiters: 1000,
      status: 'ACTIVE',
    },
  });
  await setGeography('stations', hanoiStationId, 21.0333, 105.85);

  for (const container of containerSeeds) {
    await prisma.container.upsert({
      where: { id: container.id },
      update: {
        merchantId: container.merchantId,
        wardId: container.wardId,
        qrCode: container.qrCode,
        state: ContainerState.AT_MERCHANT,
        status: 'ACTIVE',
        capacityLiters: 30,
        isActive: true,
        deletedAt: null,
      },
      create: {
        id: container.id,
        merchantId: container.merchantId,
        wardId: container.wardId,
        qrCode: container.qrCode,
        state: ContainerState.AT_MERCHANT,
        status: 'ACTIVE',
        capacityLiters: 30,
      },
    });
  }

  await prisma.oilPrice.upsert({
    where: { id: initialOilPriceId },
    update: {},
    create: {
      id: initialOilPriceId,
      unitPrice: 6000,
      unit: PriceUnit.PER_LITER,
      effectiveFrom: startOfCurrentMonthInVietnam(),
      effectiveTo: null,
      note: 'Đơn giá khởi tạo cho MVP',
    },
  });

  const counts = await prisma.$queryRaw<Array<Record<string, number>>>`
    SELECT
      (SELECT COUNT(*)::int FROM "wards") AS wards,
      (SELECT COUNT(*)::int FROM "users") AS users,
      (SELECT COUNT(*)::int FROM "merchants") AS merchants,
      (SELECT COUNT(*)::int FROM "collectors") AS collectors,
      (SELECT COUNT(*)::int FROM "stations") AS stations,
      (SELECT COUNT(*)::int FROM "containers") AS containers,
      (SELECT COUNT(*)::int FROM "oil_prices") AS oil_prices
  `;
  const postgis = await prisma.$queryRaw<Array<{ version: string }>>`SELECT PostGIS_Version() AS version`;
  const locations = await prisma.$queryRaw<Array<{ businessName: string; wkt: string }>>`
    SELECT "business_name" AS "businessName", ST_AsText("location"::geometry) AS wkt
    FROM "merchants"
    ORDER BY "business_name"
  `;
  const loginUsers = await prisma.$queryRaw<Array<{ zaloId: string; role: string; name: string }>>`
    SELECT "zalo_id" AS "zaloId", role::text, COALESCE(name, '') AS name
    FROM "users"
    WHERE "zalo_id" LIKE 'zalo_%'
    ORDER BY role, "zalo_id"
  `;

  console.info('\nSeed login users:');
  console.table(loginUsers);
  console.info(
    JSON.stringify(
      {
        seeded: counts[0],
        verification: {
          postgisVersion: postgis[0]?.version,
          merchantLocations: locations,
        },
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

import {
  ContainerState,
  PrismaClient,
  Role,
} from '@prisma/client';

const prisma = new PrismaClient();

const wardId = '10000000-0000-4000-8000-000000000001';
const stationId = '30000000-0000-4000-8000-000000000001';
const stationUserId = '40000000-0000-4000-8000-000000000001';

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
    qrCode: `ECO-UCO-Q3P7-${String(merchantIndex * 2 + index + 1).padStart(3, '0')}`,
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
      city: 'Ho Chi Minh City',
      centerLat: 10.7818,
      centerLng: 106.6851,
      deletedAt: null,
    },
    create: {
      id: wardId,
      code: 'Q3-P7',
      name: 'Phường 7, Quận 3',
      city: 'Ho Chi Minh City',
      centerLat: 10.7818,
      centerLng: 106.6851,
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
        address: merchant.address,
        avgDailyLiters: merchant.avgDailyLiters,
        lastCollectedAt: new Date(Date.now() - merchant.lastCollectedDaysAgo * 24 * 60 * 60 * 1000),
        status: 'ACTIVE',
        isActive: true,
        deletedAt: null,
      },
      create: {
        id: merchant.id,
        userId: merchant.userId,
        wardId,
        businessName: merchant.businessName,
        address: merchant.address,
        avgDailyLiters: merchant.avgDailyLiters,
        lastCollectedAt: new Date(Date.now() - merchant.lastCollectedDaysAgo * 24 * 60 * 60 * 1000),
        status: 'ACTIVE',
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
        wardId,
        displayName: collector.displayName,
        maxCapacityLiters: 100,
        status: 'ACTIVE',
        isActive: true,
        deletedAt: null,
      },
      create: {
        id: collector.id,
        userId: collector.userId,
        wardId,
        displayName: collector.displayName,
        maxCapacityLiters: 100,
        status: 'ACTIVE',
      },
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

  for (const container of containerSeeds) {
    await prisma.container.upsert({
      where: { id: container.id },
      update: {
        merchantId: container.merchantId,
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
        qrCode: container.qrCode,
        state: ContainerState.AT_MERCHANT,
        status: 'ACTIVE',
        capacityLiters: 30,
      },
    });
  }

  const counts = await prisma.$queryRaw<Array<Record<string, number>>>`
    SELECT
      (SELECT COUNT(*)::int FROM "wards") AS wards,
      (SELECT COUNT(*)::int FROM "users") AS users,
      (SELECT COUNT(*)::int FROM "merchants") AS merchants,
      (SELECT COUNT(*)::int FROM "collectors") AS collectors,
      (SELECT COUNT(*)::int FROM "stations") AS stations,
      (SELECT COUNT(*)::int FROM "containers") AS containers
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

  console.log('\nSeed login users:');
  console.table(loginUsers);
  console.log(
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

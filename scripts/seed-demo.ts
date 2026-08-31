import {
  ContainerState,
  EntityStatus,
  MerchantApprovalStatus,
  OilGrade,
  OrderStatus,
  PrismaClient,
  Quality,
  Role,
} from '@prisma/client';
import { getDemoWardId, upsertDemoWards } from '../apps/api/src/demo/seed-demo-wards';

const prisma = new PrismaClient();

const merchants = [
  [
    '71000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000001',
    'zalo_demo_merchant_01',
    '0901000001',
    'Bún Chả Phố Cổ',
    '18 Hàng Bạc, Hoàn Kiếm, Hà Nội',
    'HB-HK-DEMO',
    21.0338,
    105.8511,
  ],
  [
    '71000000-0000-4000-8000-000000000002',
    '71100000-0000-4000-8000-000000000002',
    'zalo_demo_merchant_02',
    '0901000002',
    'Bếp Xanh Cống Vị',
    '52 Đội Cấn, Ba Đình, Hà Nội',
    'CV-BD-DEMO',
    21.0352,
    105.8151,
  ],
  [
    '71000000-0000-4000-8000-000000000003',
    '71100000-0000-4000-8000-000000000003',
    'zalo_demo_merchant_03',
    '0901000003',
    'Phở Nguyễn Du',
    '40 Nguyễn Du, Hai Bà Trưng, Hà Nội',
    'NT-HBT-DEMO',
    21.0187,
    105.8458,
  ],
  [
    '71000000-0000-4000-8000-000000000004',
    '71100000-0000-4000-8000-000000000004',
    'zalo_demo_merchant_04',
    '0901000004',
    'Cơm Nhà Hồ Gươm',
    '8 Đinh Tiên Hoàng, Hoàn Kiếm, Hà Nội',
    'HB-HK-DEMO',
    21.0288,
    105.8524,
  ],
  [
    '71000000-0000-4000-8000-000000000005',
    '71100000-0000-4000-8000-000000000005',
    'zalo_demo_merchant_05',
    '0901000005',
    'Bún Riêu Trung Tự',
    '16 Phạm Ngọc Thạch, Đống Đa, Hà Nội',
    'TD-DD-DEMO',
    21.0097,
    105.8302,
  ],
] as const;

async function main() {
  const wardIdsByCode = await upsertDemoWards(prisma);

  for (const [
    index,
    [merchantId, userId, zaloId, phone, businessName, address, wardCode, lat, lng],
  ] of merchants.entries()) {
    const wardId = getDemoWardId(wardIdsByCode, wardCode);
    await prisma.user.upsert({
      where: { id: userId },
      update: { zaloId, phone, name: businessName, role: Role.MERCHANT, deletedAt: null },
      create: { id: userId, zaloId, phone, name: businessName, role: Role.MERCHANT },
    });
    await prisma.merchant.upsert({
      where: { id: merchantId },
      update: {
        userId,
        wardId,
        businessName,
        address,
        status: EntityStatus.ACTIVE,
        isActive: true,
        approvalStatus: MerchantApprovalStatus.APPROVED,
        deletedAt: null,
      },
      create: {
        id: merchantId,
        userId,
        wardId,
        businessName,
        address,
        status: EntityStatus.ACTIVE,
        isActive: true,
        approvalStatus: MerchantApprovalStatus.APPROVED,
      },
    });
    await prisma.$executeRaw`UPDATE "merchants" SET "location" = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography WHERE "id" = ${merchantId}::uuid`;
    const containerId = `72000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    await prisma.container.upsert({
      where: { id: containerId },
      update: {
        merchantId,
        wardId,
        qrCode: `ECO-DEMO-${wardCode}-${String(index + 1).padStart(3, '0')}`,
        state: ContainerState.AT_MERCHANT,
        status: EntityStatus.ACTIVE,
        isActive: true,
        capacityLiters: 30,
        deletedAt: null,
      },
      create: {
        id: containerId,
        merchantId,
        wardId,
        qrCode: `ECO-DEMO-${wardCode}-${String(index + 1).padStart(3, '0')}`,
        state: ContainerState.AT_MERCHANT,
        status: EntityStatus.ACTIVE,
        isActive: true,
        capacityLiters: 30,
      },
    });
  }

  const collectors = [
    [
      '73000000-0000-4000-8000-000000000001',
      '73100000-0000-4000-8000-000000000001',
      'zalo_demo_collector_01',
      '0911000001',
      'Nguyễn Thu Gom 1',
      'HB-HK-DEMO',
    ],
    [
      '73000000-0000-4000-8000-000000000002',
      '73100000-0000-4000-8000-000000000002',
      'zalo_demo_collector_02',
      '0911000002',
      'Trần Thu Gom 2',
      'NT-HBT-DEMO',
    ],
  ] as const;
  for (const [collectorId, userId, zaloId, phone, name, wardCode] of collectors) {
    const wardId = getDemoWardId(wardIdsByCode, wardCode);
    await prisma.user.upsert({
      where: { id: userId },
      update: { zaloId, phone, name, role: Role.COLLECTOR, deletedAt: null },
      create: { id: userId, zaloId, phone, name, role: Role.COLLECTOR },
    });
    await prisma.collector.upsert({
      where: { id: collectorId },
      update: {
        userId,
        displayName: name,
        vehicleType: 'Xe tải nhỏ',
        maxCapacityLiters: 100,
        status: EntityStatus.ACTIVE,
        isActive: true,
        deletedAt: null,
      },
      create: {
        id: collectorId,
        userId,
        displayName: name,
        vehicleType: 'Xe tải nhỏ',
        maxCapacityLiters: 100,
        status: EntityStatus.ACTIVE,
        isActive: true,
      },
    });
    await prisma.collectorWard.upsert({
      where: { collectorId_wardId: { collectorId, wardId } },
      update: {},
      create: { collectorId, wardId },
    });
  }

  const stationUserId = '74100000-0000-4000-8000-000000000001';
  const stationId = '74000000-0000-4000-8000-000000000001';
  const stationWardId = getDemoWardId(wardIdsByCode, 'HB-HK-DEMO');
  await prisma.user.upsert({
    where: { id: stationUserId },
    update: {
      zaloId: 'zalo_demo_station_01',
      phone: '0921000001',
      name: 'Trạm ECollect Hồ Gươm',
      role: Role.STATION,
      deletedAt: null,
    },
    create: {
      id: stationUserId,
      zaloId: 'zalo_demo_station_01',
      phone: '0921000001',
      name: 'Trạm ECollect Hồ Gươm',
      role: Role.STATION,
    },
  });
  await prisma.station.upsert({
    where: { id: stationId },
    update: {
      userId: stationUserId,
      wardId: stationWardId,
      name: 'Trạm ECollect Hồ Gươm',
      address: '22 Hàng Bạc, Hoàn Kiếm, Hà Nội',
      capacityLiters: 1000,
      currentVolumeLiters: 0,
      status: EntityStatus.ACTIVE,
      isActive: true,
      deletedAt: null,
    },
    create: {
      id: stationId,
      userId: stationUserId,
      wardId: stationWardId,
      name: 'Trạm ECollect Hồ Gươm',
      address: '22 Hàng Bạc, Hoàn Kiếm, Hà Nội',
      capacityLiters: 1000,
      currentVolumeLiters: 0,
      status: EntityStatus.ACTIVE,
      isActive: true,
    },
  });
  await prisma.$executeRaw`UPDATE "stations" SET "location" = ST_SetSRID(ST_MakePoint(105.8504, 21.0328), 4326)::geography WHERE "id" = ${stationId}::uuid`;

  const secondStationUserId = '74100000-0000-4000-8000-000000000002';
  const secondStationId = '74000000-0000-4000-8000-000000000002';
  const secondStationWardId = getDemoWardId(wardIdsByCode, 'CV-BD-DEMO');
  await prisma.user.upsert({
    where: { id: secondStationUserId },
    update: {
      zaloId: null,
      phone: null,
      name: 'Trạm ECollect Cống Vị',
      role: Role.STATION,
      deletedAt: null,
    },
    create: { id: secondStationUserId, name: 'Trạm ECollect Cống Vị', role: Role.STATION },
  });
  await prisma.station.upsert({
    where: { id: secondStationId },
    update: {
      userId: secondStationUserId,
      wardId: secondStationWardId,
      name: 'Trạm ECollect Cống Vị',
      address: '80 Đội Cấn, Ba Đình, Hà Nội',
      capacityLiters: 1500,
      currentVolumeLiters: 120,
      status: EntityStatus.ACTIVE,
      isActive: true,
      deletedAt: null,
    },
    create: {
      id: secondStationId,
      userId: secondStationUserId,
      wardId: secondStationWardId,
      name: 'Trạm ECollect Cống Vị',
      address: '80 Đội Cấn, Ba Đình, Hà Nội',
      capacityLiters: 1500,
      currentVolumeLiters: 120,
      status: EntityStatus.ACTIVE,
      isActive: true,
    },
  });
  await prisma.$executeRaw`UPDATE "stations" SET "location" = ST_SetSRID(ST_MakePoint(105.8151, 21.0352), 4326)::geography WHERE "id" = ${secondStationId}::uuid`;

  const demoOrders = merchants.slice(0, 3).map(([merchantId], index) => ({
    id: `76000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    merchantId,
    containerId: `72000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    collectorId:
      index < 2 ? '73000000-0000-4000-8000-000000000001' : '73000000-0000-4000-8000-000000000002',
    expectedLiters: 20 + index * 5,
  }));
  for (const order of demoOrders) {
    await prisma.collectionOrder.upsert({
      where: { id: order.id },
      update: { ...order, status: OrderStatus.ASSIGNED, deletedAt: null },
      create: { ...order, status: OrderStatus.ASSIGNED },
    });
  }
  await prisma.collectionTransaction.upsert({
    where: { id: '77000000-0000-4000-8000-000000000001' },
    update: {
      orderId: demoOrders[0].id,
      containerId: demoOrders[0].containerId,
      merchantId: demoOrders[0].merchantId,
      collectorId: demoOrders[0].collectorId,
      actualLiters: 18,
      grade: OilGrade.A,
      quality: Quality.PASS,
      deletedAt: null,
    },
    create: {
      id: '77000000-0000-4000-8000-000000000001',
      clientUuid: '77100000-0000-4000-8000-000000000001',
      orderId: demoOrders[0].id,
      containerId: demoOrders[0].containerId,
      merchantId: demoOrders[0].merchantId,
      collectorId: demoOrders[0].collectorId,
      actualLiters: 18,
      grade: OilGrade.A,
      quality: Quality.PASS,
    },
  });

  const admin = await prisma.user.findUnique({ where: { zaloId: 'zalo_admin_01' } });
  if (admin) {
    await prisma.user.update({
      where: { id: admin.id },
      data: { phone: '0900000000', name: 'ECollect Admin', role: Role.ADMIN, deletedAt: null },
    });
  } else {
    await prisma.user.create({
      data: {
        id: '75000000-0000-4000-8000-000000000001',
        zaloId: 'zalo_admin_01',
        phone: '0900000000',
        name: 'ECollect Admin',
        role: Role.ADMIN,
      },
    });
  }
  console.log(
    'Demo seed complete: 4 Hanoi wards, 5 merchants, 2 collectors, 2 stations, 5 containers, 3 orders, 1 transaction.',
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

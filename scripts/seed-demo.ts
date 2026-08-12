import { ContainerState, EntityStatus, MerchantApprovalStatus, PrismaClient, Role } from '@prisma/client';

const prisma = new PrismaClient();

const wards = [
  { id: '70000000-0000-4000-8000-000000000001', code: 'Q3-P7-DEMO', name: 'Phường 7, Quận 3', district: 'Quận 3', city: 'TP. Hồ Chí Minh', centerLat: 10.7818, centerLng: 106.6851 },
  { id: '70000000-0000-4000-8000-000000000002', code: 'HB-HK-DEMO', name: 'Phường Hàng Bạc', district: 'Quận Hoàn Kiếm', city: 'Hà Nội', centerLat: 21.0333, centerLng: 105.85 },
];

const merchants = [
  ['71000000-0000-4000-8000-000000000001', '71100000-0000-4000-8000-000000000001', 'zalo_demo_merchant_01', '0901000001', 'Quán Cơm Sài Thành', '12 Nguyễn Thị Minh Khai, Quận 3', wards[0], 10.78255, 106.68475],
  ['71000000-0000-4000-8000-000000000002', '71100000-0000-4000-8000-000000000002', 'zalo_demo_merchant_02', '0901000002', 'Bếp Xanh Quận 3', '35 Võ Văn Tần, Quận 3', wards[0], 10.78195, 106.68535],
  ['71000000-0000-4000-8000-000000000003', '71100000-0000-4000-8000-000000000003', 'zalo_demo_merchant_03', '0901000003', 'Phở Sài Gòn', '88 Điện Biên Phủ, Quận 3', wards[0], 10.78305, 106.68615],
  ['71000000-0000-4000-8000-000000000004', '71100000-0000-4000-8000-000000000004', 'zalo_demo_merchant_04', '0901000004', 'Bún Chả Hàng Bạc', '18 Hàng Bạc, Hoàn Kiếm', wards[1], 21.0338, 105.8511],
  ['71000000-0000-4000-8000-000000000005', '71100000-0000-4000-8000-000000000005', 'zalo_demo_merchant_05', '0901000005', 'Cơm Nhà Hồ Gươm', '8 Đinh Tiên Hoàng, Hoàn Kiếm', wards[1], 21.0288, 105.8524],
] as const;

async function main() {
  for (const ward of wards) {
    await prisma.ward.upsert({ where: { id: ward.id }, update: { code: ward.code, name: ward.name, district: ward.district, city: ward.city, centerLat: ward.centerLat, centerLng: ward.centerLng, status: EntityStatus.ACTIVE, isActive: true, deletedAt: null }, create: { ...ward, status: EntityStatus.ACTIVE, isActive: true } });
  }

  for (const [index, [merchantId, userId, zaloId, phone, businessName, address, ward, lat, lng]] of merchants.entries()) {
    await prisma.user.upsert({ where: { id: userId }, update: { zaloId, phone, name: businessName, role: Role.MERCHANT, deletedAt: null }, create: { id: userId, zaloId, phone, name: businessName, role: Role.MERCHANT } });
    await prisma.merchant.upsert({ where: { id: merchantId }, update: { userId, wardId: ward.id, businessName, address, status: EntityStatus.ACTIVE, isActive: true, approvalStatus: MerchantApprovalStatus.APPROVED, deletedAt: null }, create: { id: merchantId, userId, wardId: ward.id, businessName, address, status: EntityStatus.ACTIVE, isActive: true, approvalStatus: MerchantApprovalStatus.APPROVED } });
    await prisma.$executeRaw`UPDATE "merchants" SET "location" = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography WHERE "id" = ${merchantId}::uuid`;
    const containerId = `72000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    await prisma.container.upsert({ where: { id: containerId }, update: { merchantId, wardId: ward.id, qrCode: `ECO-DEMO-${ward.code}-${String(index + 1).padStart(3, '0')}`, state: ContainerState.AT_MERCHANT, status: EntityStatus.ACTIVE, isActive: true, capacityLiters: 30, deletedAt: null }, create: { id: containerId, merchantId, wardId: ward.id, qrCode: `ECO-DEMO-${ward.code}-${String(index + 1).padStart(3, '0')}`, state: ContainerState.AT_MERCHANT, status: EntityStatus.ACTIVE, isActive: true, capacityLiters: 30 } });
  }

  const collectors = [
    ['73000000-0000-4000-8000-000000000001', '73100000-0000-4000-8000-000000000001', 'zalo_demo_collector_01', '0911000001', 'Nguyễn Thu Gom 1', wards[0].id],
    ['73000000-0000-4000-8000-000000000002', '73100000-0000-4000-8000-000000000002', 'zalo_demo_collector_02', '0911000002', 'Trần Thu Gom 2', wards[1].id],
  ] as const;
  for (const [collectorId, userId, zaloId, phone, name, wardId] of collectors) {
    await prisma.user.upsert({ where: { id: userId }, update: { zaloId, phone, name, role: Role.COLLECTOR, deletedAt: null }, create: { id: userId, zaloId, phone, name, role: Role.COLLECTOR } });
    await prisma.collector.upsert({ where: { id: collectorId }, update: { userId, displayName: name, vehicleType: 'Xe tải nhỏ', maxCapacityLiters: 100, status: EntityStatus.ACTIVE, isActive: true, deletedAt: null }, create: { id: collectorId, userId, displayName: name, vehicleType: 'Xe tải nhỏ', maxCapacityLiters: 100, status: EntityStatus.ACTIVE, isActive: true } });
    await prisma.collectorWard.upsert({ where: { collectorId_wardId: { collectorId, wardId } }, update: {}, create: { collectorId, wardId } });
  }

  const stationUserId = '74100000-0000-4000-8000-000000000001';
  const stationId = '74000000-0000-4000-8000-000000000001';
  await prisma.user.upsert({ where: { id: stationUserId }, update: { zaloId: 'zalo_demo_station_01', phone: '0921000001', name: 'Trạm Eco-Oil Hồ Gươm', role: Role.STATION, deletedAt: null }, create: { id: stationUserId, zaloId: 'zalo_demo_station_01', phone: '0921000001', name: 'Trạm Eco-Oil Hồ Gươm', role: Role.STATION } });
  await prisma.station.upsert({ where: { id: stationId }, update: { userId: stationUserId, wardId: wards[1].id, name: 'Trạm Eco-Oil Hồ Gươm', address: '22 Hàng Bạc, Hoàn Kiếm, Hà Nội', capacityLiters: 1000, currentVolumeLiters: 0, status: EntityStatus.ACTIVE, isActive: true, deletedAt: null }, create: { id: stationId, userId: stationUserId, wardId: wards[1].id, name: 'Trạm Eco-Oil Hồ Gươm', address: '22 Hàng Bạc, Hoàn Kiếm, Hà Nội', capacityLiters: 1000, currentVolumeLiters: 0, status: EntityStatus.ACTIVE, isActive: true } });
  await prisma.$executeRaw`UPDATE "stations" SET "location" = ST_SetSRID(ST_MakePoint(105.8504, 21.0328), 4326)::geography WHERE "id" = ${stationId}::uuid`;

  const admin = await prisma.user.findUnique({ where: { zaloId: 'zalo_admin_01' } });
  if (admin) {
    await prisma.user.update({ where: { id: admin.id }, data: { phone: '0900000000', name: 'Eco-Oil Admin', role: Role.ADMIN, deletedAt: null } });
  } else {
    await prisma.user.create({ data: { id: '75000000-0000-4000-8000-000000000001', zaloId: 'zalo_admin_01', phone: '0900000000', name: 'Eco-Oil Admin', role: Role.ADMIN } });
  }
  console.log('Demo seed complete: 2 wards, 5 merchants, 2 collectors, 1 station, 5 containers.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());

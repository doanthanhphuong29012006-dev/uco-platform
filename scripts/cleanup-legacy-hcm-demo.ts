import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const merchantIds = Array.from({ length: 5 }, (_, index) =>
  `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
);
const collectorIds = [
  '50000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000003',
];
const stationIds = [
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
];
const wardIds = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
];
const userIds = [
  ...Array.from({ length: 5 }, (_, index) =>
    `40000000-0000-4000-8000-${String(101 + index).padStart(12, '0')}`,
  ),
  '40000000-0000-4000-8000-000000000201',
  '40000000-0000-4000-8000-000000000202',
  '40000000-0000-4000-8000-000000000203',
  '40000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000002',
];

async function main(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const legacyTransactions = await tx.collectionTransaction.findMany({
      where: { OR: [{ merchantId: { in: merchantIds } }, { collectorId: { in: collectorIds } }] },
      select: { id: true },
    });
    const transactionIds = legacyTransactions.map(({ id }) => id);
    const legacyDeliveries = await tx.stationDelivery.findMany({
      where: { OR: [{ stationId: { in: stationIds } }, { collectorId: { in: collectorIds } }] },
      select: { id: true },
    });
    const deliveryIds = legacyDeliveries.map(({ id }) => id);

    await tx.anomalyFeedback.deleteMany({ where: { transactionId: { in: transactionIds } } });
    await tx.payment.deleteMany({ where: { transactionId: { in: transactionIds } } });
    await tx.alert.deleteMany({
      where: {
        OR: [
          { transactionId: { in: transactionIds } },
          { stationDeliveryId: { in: deliveryIds } },
        ],
      },
    });
    await tx.collectionTransaction.deleteMany({ where: { id: { in: transactionIds } } });
    await tx.stationDelivery.deleteMany({ where: { id: { in: deliveryIds } } });
    await tx.collectionRouteStop.deleteMany({
      where: {
        OR: [
          { route: { collectorId: { in: collectorIds } } },
          { order: { merchantId: { in: merchantIds } } },
        ],
      },
    });
    await tx.collectionRoute.deleteMany({ where: { collectorId: { in: collectorIds } } });
    await tx.collectionOrder.deleteMany({
      where: { OR: [{ merchantId: { in: merchantIds } }, { collectorId: { in: collectorIds } }] },
    });
    await tx.container.deleteMany({ where: { merchantId: { in: merchantIds } } });
    await tx.collectorWard.deleteMany({
      where: { OR: [{ collectorId: { in: collectorIds } }, { wardId: { in: wardIds } }] },
    });
    await tx.merchant.deleteMany({ where: { id: { in: merchantIds } } });
    await tx.collector.deleteMany({ where: { id: { in: collectorIds } } });
    await tx.station.deleteMany({ where: { id: { in: stationIds } } });
    await tx.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
    await tx.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
    await tx.user.deleteMany({ where: { id: { in: userIds } } });
    await tx.ward.deleteMany({ where: { id: { in: wardIds } } });
  });
  console.info('Legacy fixed-ID demo records removed. Re-run pnpm db:seed to create the Hanoi demo.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());

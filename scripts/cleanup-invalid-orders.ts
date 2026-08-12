import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const candidates = await prisma.collectionOrder.findMany({
    where: { status: { in: ['READY', 'ASSIGNED'] }, deletedAt: null, expectedLiters: { not: null } },
    include: { container: { select: { capacityLiters: true } } },
  });
  const invalid = candidates.filter((order) => Number(order.expectedLiters) > Number(order.container?.capacityLiters ?? 0));
  for (const order of invalid) {
    await prisma.collectionOrder.update({
      where: { id: order.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), note: `${order.note ? `${order.note} | ` : ''}Đã thu hồi bởi cleanup: vượt dung tích can` },
    });
  }
  console.table(invalid.map((order) => ({ id: order.id, expected_liters: Number(order.expectedLiters), capacity_l: Number(order.container?.capacityLiters ?? 0), status: 'CANCELLED' })));
  console.info(`Đã thu hồi ${invalid.length} đơn sai dung tích.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());

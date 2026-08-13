import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EntityStatus, MerchantApprovalStatus, PaymentStatus, Prisma } from '@prisma/client';
import type {
  AdminPaymentListQueryInput,
  MerchantPaymentListQueryInput,
  OilPriceCreateInput,
} from '@eco-oil/validation';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import type { AccessTokenPayload } from '../auth/auth.types';
import { paymentPeriodBounds, paymentPeriodFor } from './payment-period';

type PriceReader = Pick<Prisma.TransactionClient, 'oilPrice'>;

@Injectable()
export class PaymentsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async resolveUnitPrice(at: Date, database: PriceReader = this.prisma): Promise<Prisma.Decimal> {
    const price = await database.oilPrice.findFirst({
      where: {
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: { effectiveFrom: 'desc' },
      select: { unitPrice: true },
    });
    if (!price) {
      throw new UnprocessableEntityException({
        code: 'NO_PRICE_CONFIGURED',
        message: 'Chưa cấu hình đơn giá dầu cho thời điểm giao dịch',
        details: { at: at.toISOString() },
      });
    }
    return price.unitPrice;
  }

  async run(period: string, actorUserId: string) {
    const { from, to } = this.parseBounds(period);
    const transactions = await this.prisma.collectionTransaction.findMany({
      where: { quality: 'PASS', deletedAt: null, collectedAt: { gte: from, lt: to } },
      select: { id: true, merchantId: true, actualLiters: true, collectedAt: true },
      orderBy: { collectedAt: 'asc' },
    });
    const prices = await this.prisma.oilPrice.findMany({
      where: { effectiveFrom: { lt: to }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: from } }] },
      orderBy: { effectiveFrom: 'desc' },
    });

    const snapshots = transactions.map((transaction) => {
      const price = prices.find((candidate) =>
        candidate.effectiveFrom <= transaction.collectedAt
        && (candidate.effectiveTo === null || candidate.effectiveTo > transaction.collectedAt));
      if (!price) {
        throw new UnprocessableEntityException({
          code: 'NO_PRICE_CONFIGURED',
          message: 'Chưa cấu hình đơn giá dầu cho thời điểm giao dịch',
          details: { transaction_id: transaction.id, collected_at: transaction.collectedAt.toISOString() },
        });
      }
      const amount = transaction.actualLiters.mul(price.unitPrice).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
      return { transaction, unitPrice: price.unitPrice, amount };
    });

    return this.prisma.$transaction(async (database) => {
      let created = 0;
      let totalAmount = new Prisma.Decimal(0);
      for (const snapshot of snapshots) {
        const inserted = await database.$queryRaw<Array<{ amount: Prisma.Decimal }>>`
          INSERT INTO "payments" (
            "id", "merchant_id", "transaction_id", "liters", "unit_price", "amount", "period", "status", "created_at"
          ) VALUES (
            ${randomUUID()}::uuid,
            ${snapshot.transaction.merchantId}::uuid,
            ${snapshot.transaction.id}::uuid,
            ${snapshot.transaction.actualLiters},
            ${snapshot.unitPrice},
            ${snapshot.amount},
            ${period},
            'PENDING'::"PaymentStatus",
            NOW()
          )
          ON CONFLICT ("transaction_id") DO NOTHING
          RETURNING "amount"
        `;
        if (inserted[0]) {
          created += 1;
          totalAmount = totalAmount.add(inserted[0].amount);
        }
      }
      await database.auditLog.create({
        data: {
          actorUserId,
          action: 'RUN_PAYMENT_PERIOD',
          entityType: 'PaymentPeriod',
          entityId: period,
          details: { created, skipped: transactions.length - created, total_amount: totalAmount.toNumber() },
        },
      });
      return { created, skipped: transactions.length - created, total_amount: totalAmount.toNumber() };
    });
  }

  async listAdmin(query: AdminPaymentListQueryInput) {
    return this.list({
      period: query.period,
      merchantId: query.merchant_id,
      status: query.status,
      page: query.page,
      limit: query.limit,
    });
  }

  async listMerchant(user: AccessTokenPayload, query: MerchantPaymentListQueryInput) {
    const merchant = await this.prisma.merchant.findUnique({ where: { userId: user.sub } });
    if (!merchant || merchant.status === EntityStatus.INACTIVE) throw new NotFoundException('Merchant profile not found');
    if (merchant.approvalStatus !== MerchantApprovalStatus.APPROVED) {
      throw new ForbiddenException({
        code: 'MERCHANT_NOT_APPROVED',
        message: 'Tài khoản quán chưa được duyệt',
        details: { approval_status: merchant.approvalStatus },
      });
    }
    return this.list({
      period: query.period,
      merchantId: merchant.id,
      status: query.status,
      page: query.page,
      limit: query.limit,
    });
  }

  async markPaid(id: string, actorUserId: string) {
    return this.prisma.$transaction(async (database) => {
      const payment = await database.payment.findUnique({ where: { id } });
      if (!payment) throw new NotFoundException('Payment not found');
      if (payment.status === PaymentStatus.PAID) {
        throw new ConflictException({
          code: 'PAYMENT_ALREADY_PAID',
          message: 'Khoản thanh toán này đã được đánh dấu là đã trả',
          details: { payment_id: id, paid_at: payment.paidAt },
        });
      }
      if (payment.status !== PaymentStatus.PENDING) {
        throw new ConflictException({
          code: 'PAYMENT_NOT_PENDING',
          message: 'Chỉ khoản đang chờ thanh toán mới có thể đánh dấu đã trả',
          details: { payment_id: id, status: payment.status },
        });
      }
      const updated = await database.payment.update({
        where: { id },
        data: { status: PaymentStatus.PAID, paidAt: new Date() },
        include: { merchant: { select: { businessName: true } }, transaction: { select: { collectedAt: true } } },
      });
      await database.auditLog.create({
        data: {
          actorUserId,
          action: 'MARK_PAYMENT_PAID',
          entityType: 'Payment',
          entityId: id,
          details: { amount: updated.amount.toNumber(), merchant_id: updated.merchantId },
        },
      });
      return this.serializePayment(updated);
    });
  }

  async listOilPrices() {
    const rows = await this.prisma.oilPrice.findMany({ orderBy: { effectiveFrom: 'desc' } });
    return rows.map((row) => this.serializePrice(row));
  }

  async createOilPrice(input: OilPriceCreateInput, actorUserId: string) {
    const effectiveFrom = input.effective_from ?? new Date();
    try {
      return await this.prisma.$transaction(async (database) => {
        const current = await database.oilPrice.findFirst({
          where: { effectiveTo: null },
          orderBy: { effectiveFrom: 'desc' },
        });
        if (current && effectiveFrom <= current.effectiveFrom) {
          throw new ConflictException({
            code: 'INVALID_PRICE_EFFECTIVE_DATE',
            message: 'Thời điểm áp dụng đơn giá mới phải sau thời điểm bắt đầu của đơn giá hiện hành',
            details: { current_effective_from: current.effectiveFrom.toISOString() },
          });
        }
        if (current) {
          await database.oilPrice.update({ where: { id: current.id }, data: { effectiveTo: effectiveFrom } });
        }
        const created = await database.oilPrice.create({
          data: { unitPrice: input.unit_price, effectiveFrom, note: input.note },
        });
        await database.auditLog.create({
          data: {
            actorUserId,
            action: 'CREATE_OIL_PRICE',
            entityType: 'OilPrice',
            entityId: created.id,
            details: { unit_price: input.unit_price, effective_from: effectiveFrom.toISOString() },
          },
        });
        return this.serializePrice(created);
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2004') {
        throw new ConflictException({
          code: 'OIL_PRICE_PERIOD_OVERLAP',
          message: 'Khoảng thời gian áp dụng đơn giá bị chồng với cấu hình hiện có',
          details: null,
        });
      }
      throw error;
    }
  }

  private async list(input: {
    period?: string;
    merchantId?: string;
    status?: PaymentStatus;
    page: number;
    limit: number;
  }) {
    if (input.period) this.parseBounds(input.period);
    const where: Prisma.PaymentWhereInput = {
      ...(input.period ? { period: input.period } : {}),
      ...(input.merchantId ? { merchantId: input.merchantId } : {}),
      ...(input.status ? { status: input.status } : {}),
    };
    const [rows, total, aggregate] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        include: { merchant: { select: { businessName: true } }, transaction: { select: { collectedAt: true } } },
        orderBy: [{ period: 'desc' }, { createdAt: 'desc' }],
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
      this.prisma.payment.count({ where }),
      this.prisma.payment.aggregate({ where, _sum: { liters: true, amount: true } }),
    ]);
    return {
      data: rows.map((row) => this.serializePayment(row)),
      meta: { page: input.page, limit: input.limit, total },
      totals: {
        liters: Number(aggregate._sum.liters ?? 0),
        amount: Number(aggregate._sum.amount ?? 0),
      },
    };
  }

  private serializePayment(payment: {
    id: string;
    merchantId: string;
    transactionId: string;
    liters: Prisma.Decimal;
    unitPrice: Prisma.Decimal;
    amount: Prisma.Decimal;
    period: string;
    status: PaymentStatus;
    paidAt: Date | null;
    createdAt: Date;
    merchant: { businessName: string };
    transaction: { collectedAt: Date };
  }) {
    return {
      id: payment.id,
      merchant_id: payment.merchantId,
      merchant_name: payment.merchant.businessName,
      transaction_id: payment.transactionId,
      liters: payment.liters.toNumber(),
      unit_price: payment.unitPrice.toNumber(),
      amount: payment.amount.toNumber(),
      period: payment.period,
      status: payment.status,
      paid_at: payment.paidAt,
      created_at: payment.createdAt,
      collected_at: payment.transaction.collectedAt,
    };
  }

  private serializePrice(price: {
    id: string;
    unitPrice: Prisma.Decimal;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    note: string | null;
    createdAt: Date;
  }) {
    return {
      id: price.id,
      unit_price: price.unitPrice.toNumber(),
      effective_from: price.effectiveFrom,
      effective_to: price.effectiveTo,
      note: price.note,
      created_at: price.createdAt,
    };
  }

  private parseBounds(period: string) {
    try {
      return paymentPeriodBounds(period);
    } catch {
      throw new BadRequestException({
        code: 'INVALID_PAYMENT_PERIOD',
        message: 'Kỳ thanh toán không hợp lệ; định dạng yêu cầu là YYYY-Www theo tuần ISO',
        details: { period },
      });
    }
  }

  periodForTransaction(collectedAt: Date): string {
    return paymentPeriodFor(collectedAt);
  }
}

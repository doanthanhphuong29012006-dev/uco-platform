import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ContainerState, EntityStatus } from '@prisma/client';
import type { ContainerAssignInput, ContainerCreateInput, ContainerListQueryInput, EntityStatusInput } from '@eco-oil/validation';
import { PrismaService } from '../../prisma/prisma.service';
import { buildContainerQrCode, containerQrPrefix, wardLookupKey } from './qr-code';

@Injectable()
export class ContainersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: ContainerCreateInput) {
    const merchant = await this.requireMerchant(input.merchant_id);
    const ward = await this.prisma.ward.findUnique({ where: { id: merchant.wardId } });
    if (!ward) {
      throw new NotFoundException('Merchant ward not found');
    }
    if (input.ward_code && wardLookupKey(input.ward_code) !== wardLookupKey(ward.code)) {
      throw new ConflictException('ward_code does not match merchant ward');
    }
    const qrCode = input.qr_code ?? (await this.nextQrCode(ward.code));
    const row = await this.prisma.container.create({
      data: {
        merchantId: merchant.id,
        wardId: merchant.wardId,
        qrCode,
        state: input.state ?? ContainerState.AT_MERCHANT,
        capacityLiters: input.capacity_liters,
      },
      include: { merchant: true },
    });
    return this.serialize(row);
  }

  async assign(id: string, input: ContainerAssignInput) {
    const existing = await this.getRequired(id);
    if (existing.merchantId && existing.merchantId !== input.merchant_id) {
      throw new ConflictException({ code: 'CONTAINER_ALREADY_ASSIGNED', message: 'Container is already assigned to another merchant', details: { merchant_id: existing.merchantId } });
    }
    const merchant = await this.requireMerchant(input.merchant_id);
    const row = await this.prisma.container.update({
      where: { id },
      data: { merchantId: input.merchant_id, wardId: merchant.wardId, state: ContainerState.AT_MERCHANT },
      include: { merchant: true },
    });
    return this.serialize(row);
  }

  async updateStatus(id: string, input: EntityStatusInput) {
    await this.getRequired(id);
    const row = await this.prisma.container.update({
      where: { id },
      data: { status: input.status, isActive: input.status === EntityStatus.ACTIVE, deletedAt: input.status === EntityStatus.INACTIVE ? new Date() : null },
      include: { merchant: true },
    });
    return this.serialize(row);
  }

  async byQr(code: string) {
    const row = await this.prisma.container.findUnique({ where: { qrCode: code }, include: { merchant: true } });
    if (!row || row.status === EntityStatus.INACTIVE || !row.merchant) {
      throw new NotFoundException('Container not found');
    }
    return this.serialize(row, true);
  }

  async list(query: ContainerListQueryInput) {
    const where: Prisma.ContainerWhereInput = {
      ...(query.state ? { state: query.state } : {}),
      ...(query.merchant_id ? { merchantId: query.merchant_id } : {}),
      ...(query.include_inactive ? {} : { status: EntityStatus.ACTIVE }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.container.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { merchant: true },
      }),
      this.prisma.container.count({ where }),
    ]);
    return { data: await Promise.all(rows.map((row) => this.serialize(row))), meta: { page: query.page, limit: query.limit, total } };
  }

  private async nextQrCode(wardCode: string): Promise<string> {
    const prefix = containerQrPrefix(wardCode);
    const rows = await this.prisma.container.findMany({ where: { qrCode: { startsWith: prefix } }, select: { qrCode: true } });
    const max = rows.reduce((highest, row) => {
      const suffix = Number(row.qrCode.slice(prefix.length));
      return Number.isInteger(suffix) && suffix > highest ? suffix : highest;
    }, 0);
    return buildContainerQrCode(wardCode, max + 1);
  }

  private async requireMerchant(id: string) {
    const merchant = await this.prisma.merchant.findUnique({ where: { id } });
    if (!merchant || merchant.status === EntityStatus.INACTIVE) {
      throw new NotFoundException('Merchant not found');
    }
    return merchant;
  }

  private async getRequired(id: string) {
    const row = await this.prisma.container.findUnique({ where: { id }, include: { merchant: true } });
    if (!row) {
      throw new NotFoundException('Container not found');
    }
    return row;
  }

  private serialize(row: { id: string; qrCode: string; state: ContainerState; status: EntityStatus; capacityLiters: Prisma.Decimal | null; merchant: { id: string; businessName: string; address: string | null; wardId: string } | null }, includeLocation = false) {
    return this.serializeAsync(row, includeLocation);
  }

  private async serializeAsync(row: { id: string; qrCode: string; state: ContainerState; status: EntityStatus; capacityLiters: Prisma.Decimal | null; merchant: { id: string; businessName: string; address: string | null; wardId: string } | null }, includeLocation: boolean) {
    const point = includeLocation && row.merchant ? await this.prisma.getGeographyPoint('merchants', row.merchant.id) : null;
    return {
      id: row.id,
      qr_code: row.qrCode,
      state: row.state,
      status: row.status,
      capacity_liters: row.capacityLiters === null ? null : Number(row.capacityLiters),
      merchant: row.merchant ? {
        id: row.merchant.id,
        name: row.merchant.businessName,
        address: row.merchant.address,
        ...(point ? { lat: point.lat, lng: point.lng } : {}),
      } : null,
    };
  }
}

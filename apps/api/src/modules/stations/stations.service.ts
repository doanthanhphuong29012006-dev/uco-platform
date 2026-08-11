import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma} from '@prisma/client';
import { EntityStatus, Role } from '@prisma/client';
import type { EntityStatusInput, PersonListQueryInput, StationCreateInput, StationPatchInput, StationRecommendInput } from '@eco-oil/validation';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class StationsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: StationCreateInput) {
    await this.requireUser(input.user_id);
    await this.requireWard(input.ward_id);
    const existing = await this.prisma.station.findUnique({ where: { userId: input.user_id } });
    if (existing) {
      throw new ConflictException('Station profile already exists');
    }
    const row = await this.prisma.station.create({
      data: { userId: input.user_id, wardId: input.ward_id, name: input.name, address: input.address },
      include: { user: true, ward: true },
    });
    await this.prisma.setGeographyPoint('stations', row.id, input.lat, input.lng);
    return this.findOne(row.id);
  }

  async update(id: string, input: StationPatchInput) {
    await this.getRequired(id);
    if (input.user_id) {
      await this.requireUser(input.user_id);
    }
    if (input.ward_id) {
      await this.requireWard(input.ward_id);
    }
    const row = await this.prisma.station.update({
      where: { id },
      data: {
        ...(input.user_id ? { userId: input.user_id } : {}),
        ...(input.ward_id ? { wardId: input.ward_id } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.address ? { address: input.address } : {}),
      },
    });
    if (input.lat !== undefined && input.lng !== undefined) {
      await this.prisma.setGeographyPoint('stations', id, input.lat, input.lng);
    }
    return this.findOne(row.id);
  }

  async updateStatus(id: string, input: EntityStatusInput) {
    await this.getRequired(id);
    await this.prisma.station.update({
      where: { id },
      data: { status: input.status, isActive: input.status === EntityStatus.ACTIVE, deletedAt: input.status === EntityStatus.INACTIVE ? new Date() : null },
    });
    return this.findOne(id);
  }

  async list(query: PersonListQueryInput) {
    const where: Prisma.StationWhereInput = {
      ...(query.ward_id ? { wardId: query.ward_id } : {}),
      ...(query.status ? { status: query.status } : query.include_inactive ? {} : { status: EntityStatus.ACTIVE }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.station.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { user: true, ward: true },
      }),
      this.prisma.station.count({ where }),
    ]);
    const points = await this.prisma.getGeographyPoints('stations', rows.map((row) => row.id));
    const pointMap = new Map(points.map((point) => [point.id, point]));
    return { data: rows.map((row) => this.serialize(row, pointMap.get(row.id))), meta: { page: query.page, limit: query.limit, total } };
  }

  async recommend(query: StationRecommendInput) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      name: string;
      address: string | null;
      capacity_l: number;
      current_volume_l: number;
      remaining_capacity_l: number;
      distance_m: number;
      lat: number;
      lng: number;
    }>>`
      SELECT s."id", s."name", s."address",
        s."capacity_l"::float8 AS "capacity_l",
        s."current_volume_l"::float8 AS "current_volume_l",
        (s."capacity_l" - s."current_volume_l")::float8 AS "remaining_capacity_l",
        ST_Distance(
          s."location",
          ST_SetSRID(ST_MakePoint(${query.lng}, ${query.lat}), 4326)::geography
        )::float8 AS "distance_m",
        ST_Y(s."location"::geometry)::float8 AS "lat",
        ST_X(s."location"::geometry)::float8 AS "lng"
      FROM "stations" s
      WHERE s."status" = 'ACTIVE'
        AND s."deleted_at" IS NULL
        AND s."location" IS NOT NULL
        AND s."capacity_l" - s."current_volume_l" >= ${query.liters}
      ORDER BY "distance_m" ASC, s."id" ASC
    `;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      address: row.address,
      lat: row.lat,
      lng: row.lng,
      capacity_l: Number(row.capacity_l),
      current_volume_l: Number(row.current_volume_l),
      remaining_capacity_l: Number(row.remaining_capacity_l),
      distance_m: Number(row.distance_m),
    }));
  }

  async findOne(id: string) {
    const row = await this.getRequired(id);
    return this.serialize(row, (await this.prisma.getGeographyPoint('stations', id)) ?? undefined);
  }

  private async requireUser(id: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.role !== Role.STATION || user.deletedAt) {
      throw new NotFoundException('Station user not found');
    }
  }

  private async requireWard(id: string): Promise<void> {
    const ward = await this.prisma.ward.findUnique({ where: { id } });
    if (!ward || ward.deletedAt) {
      throw new NotFoundException('Ward not found');
    }
  }

  private async getRequired(id: string) {
    const row = await this.prisma.station.findUnique({ where: { id }, include: { user: true, ward: true } });
    if (!row) {
      throw new NotFoundException('Station not found');
    }
    return row;
  }

  private serialize(row: Awaited<ReturnType<StationsService['getRequired']>>, point?: { lat: number; lng: number }) {
    return {
      id: row.id,
      user_id: row.userId,
      ward_id: row.wardId,
      name: row.name,
      address: row.address,
      lat: point?.lat ?? null,
      lng: point?.lng ?? null,
      capacity_l: Number(row.capacityLiters),
      current_volume_l: Number(row.currentVolumeLiters),
      status: row.status,
      is_active: row.isActive,
      ward: { id: row.ward.id, code: row.ward.code, name: row.ward.name },
      user: { id: row.user.id, name: row.user.name, phone: row.user.phone },
    };
  }
}

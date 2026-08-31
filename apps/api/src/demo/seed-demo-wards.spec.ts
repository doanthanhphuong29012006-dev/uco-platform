import { type Prisma, type PrismaClient } from '@prisma/client';
import { demoWards, getDemoWardId, upsertDemoWards } from './seed-demo-wards';

describe('upsertDemoWards', () => {
  it('uses the existing Ward ID when the code already exists under a different UUID', async () => {
    const existingWardId = 'existing-ward-with-different-uuid';
    const rows = new Map<string, { id: string; code: string }>([
      ['HB-HK-DEMO', { id: existingWardId, code: 'HB-HK-DEMO' }],
    ]);
    const upsert = jest.fn(async (args: Prisma.WardUpsertArgs) => {
      const code = args.where.code as string;
      const existingWard = rows.get(code);
      if (existingWard) return existingWard;

      const createdWard = { id: `created-${code}`, code };
      rows.set(code, createdWard);
      return createdWard;
    });

    const prisma = { ward: { upsert } } as unknown as Pick<PrismaClient, 'ward'>;
    const firstRun = await upsertDemoWards(prisma);
    const secondRun = await upsertDemoWards(prisma);

    expect(upsert).toHaveBeenCalledTimes(demoWards.length * 2);
    demoWards.forEach((ward, index) => {
      const args = upsert.mock.calls[index][0];
      expect(args.where).toEqual({ code: ward.code });
      expect(args.create).not.toHaveProperty('id');
    });
    expect(rows.size).toBe(demoWards.length);
    expect(getDemoWardId(firstRun, 'HB-HK-DEMO')).toBe(existingWardId);
    expect(getDemoWardId(secondRun, 'HB-HK-DEMO')).toBe(existingWardId);
  });
});

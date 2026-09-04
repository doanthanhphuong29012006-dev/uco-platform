import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { merchantRegisterSchema } from '@eco-oil/validation';
import { AdminController } from '../admin/admin.controller';
import { AdminService } from '../admin/admin.service';
import { MerchantsService } from './merchants.service';
import { RolesGuard } from '../auth/guards/roles.guard';

const form = { name: 'Quán GPS', address: 'Địa chỉ đã xác nhận', phone: '+84901234567', lat: 21.03, lng: 105.85 };

describe('GPS-first merchant onboarding (isolated mocked database)', () => {
  it('accepts a PENDING profile with confirmed coordinates and no ward', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'merchant-1' });
    const execute = jest.fn();
    const tx = { merchant: { create }, user: { update: jest.fn() }, $executeRaw: execute };
    const prisma = { merchant: { findUnique: jest.fn().mockResolvedValue(null) }, ward: { findUnique: jest.fn() }, $transaction: jest.fn((fn) => fn(tx)) };
    const service = new MerchantsService(prisma as never);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'merchant-1', ward_id: null, approval_status: 'PENDING' } as never);
    await service.register({ sub: 'zalo-user', role: Role.MERCHANT } as never, merchantRegisterSchema.parse(form));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ wardId: null, approvalStatus: 'PENDING' }) }));
    expect(prisma.ward.findUnique).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('assigns ward and approves in one transaction after checking an active ward', async () => {
    const tx = { ward: { findUnique: jest.fn().mockResolvedValue({ id: 'ward-1', status: 'ACTIVE', isActive: true, deletedAt: null, centerLat: null, centerLng: null }) }, merchant: { update: jest.fn().mockResolvedValue({ id: 'merchant-1' }) }, $executeRaw: jest.fn(), auditLog: { create: jest.fn() } };
    const prisma = { merchant: { findUnique: jest.fn().mockResolvedValue({ id: 'merchant-1', wardId: null }) }, getGeographyPoint: jest.fn().mockResolvedValue({ lat: form.lat, lng: form.lng }), $transaction: jest.fn((fn) => fn(tx)) };
    const service = new AdminService(prisma as never, {} as never, {} as never);
    jest.spyOn(service as never, 'merchantProfile').mockResolvedValue({ id: 'merchant-1' } as never);
    await service.approveMerchant('merchant-1', 'admin', { lat: form.lat, lng: form.lng, ward_id: 'ward-1' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.merchant.update).toHaveBeenCalledWith({ where: { id: 'merchant-1' }, data: { wardId: 'ward-1', approvalStatus: 'APPROVED', rejectionReason: null } });
  });

  it('does not partially update coordinates or approve a profile without a ward', async () => {
    const tx = { $executeRaw: jest.fn(), merchant: { update: jest.fn() } };
    const prisma = { merchant: { findUnique: jest.fn().mockResolvedValue({ id: 'merchant-1', wardId: null }) }, getGeographyPoint: jest.fn().mockResolvedValue({ lat: form.lat, lng: form.lng }), $transaction: jest.fn((fn) => fn(tx)) };
    const service = new AdminService(prisma as never, {} as never, {} as never);
    await expect(service.approveMerchant('merchant-1', 'admin', {})).rejects.toMatchObject({ response: { code: 'MERCHANT_WARD_REQUIRED' } });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.merchant.update).not.toHaveBeenCalled();
  });

  it.each([Role.MERCHANT, Role.COLLECTOR])('blocks %s from approving merchants or creating wards', (role) => {
    const guard = new RolesGuard(new Reflector());
    for (const handler of [AdminController.prototype.approveMerchant, AdminController.prototype.createWard]) {
      const context = { getHandler: () => handler, getClass: () => AdminController, switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }) };
      expect(() => guard.canActivate(context as never)).toThrow('Insufficient role');
    }
  });
});

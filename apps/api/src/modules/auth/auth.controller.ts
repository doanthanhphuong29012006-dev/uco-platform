import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { adminLoginSchema, refreshTokenSchema, zaloAuthSchema, zaloLocationSchema } from '@eco-oil/validation';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { Roles } from './decorators/roles.decorator';
import type { AccessTokenPayload } from './auth.types';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Public()
  @Post('zalo')
  login(@Body() body: unknown) {
    return this.authService.login(zaloAuthSchema.parse(body));
  }

  @Public()
  @Post('admin/login')
  adminLogin(@Body() body: unknown) {
    return this.authService.adminLogin(adminLoginSchema.parse(body));
  }

  @Public()
  @Get('dev-accounts')
  devAccounts() {
    return this.authService.devAccounts();
  }

  @Public()
  @Post('refresh')
  refresh(@Body() body: unknown) {
    const input = refreshTokenSchema.parse(body);
    return this.authService.refresh(input.refresh_token);
  }

  @Roles(Role.MERCHANT, Role.COLLECTOR, Role.STATION, Role.ADMIN)
  @Post('logout')
  logout(@CurrentUser() user: AccessTokenPayload, @Body() body: unknown) {
    const input = refreshTokenSchema.parse(body);
    return this.authService.logout(user.sub, input.refresh_token);
  }

  @Roles(Role.MERCHANT, Role.COLLECTOR, Role.STATION, Role.ADMIN)
  @Get('me')
  me(@CurrentUser() user: AccessTokenPayload) {
    return this.authService.me(user.sub);
  }

  @Roles(Role.MERCHANT, Role.COLLECTOR, Role.STATION, Role.ADMIN)
  @Post('zalo/location')
  resolveZaloLocation(@Body() body: unknown) {
    return this.authService.resolveZaloLocation(zaloLocationSchema.parse(body));
  }

  @Roles(Role.ADMIN)
  @Get('admin-check')
  adminCheck() {
    return { ok: true, role: Role.ADMIN };
  }
}
